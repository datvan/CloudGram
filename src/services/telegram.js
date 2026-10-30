import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { AuthKey } from "telegram/crypto/AuthKey";
import { Buffer } from "buffer/";

import { API_ID, API_HASH } from "../config/config";
import { ConnectionWebCryptoObfuscated } from "./obfuscatedTransport";
import { offloadDecryption } from "./decryptWorkers";

offloadDecryption();

/**
 * The one Telegram connection the app uses.
 *
 * It used to be built at import time over a StoreSession, which wrote the auth
 * key into localStorage in plain text. Now the session string is fetched from
 * the encrypted vault after unlock and kept in memory only, so the client can
 * only be created then; everything else reaches it through getClient().
 */
let client = null;

export function newClient(session = "") {
    return new TelegramClient(new StringSession(session), API_ID, API_HASH, {
        connectionRetries: 5,
        // GramJS's own, with the per-byte encryption moved to WebCrypto
        connection: ConnectionWebCryptoObfuscated,
    });
}

const listeners = new Set();

/** Hear when the client is set or stopped, e.g. to resume waiting uploads. */
export function onClientChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Adopt a connected client, e.g. the one that just finished logging in. */
export function setClient(next) {
    client = next;
    listeners.forEach((listener) => listener(client));
}

/** Is Telegram reachable right now? False while GramJS reconnects. */
export function isOnline() {
    return client !== null && client.connected !== false;
}

export function getClient() {
    if (!client) throw new Error("Telegram is not connected");
    return client;
}

export function hasClient() {
    return client !== null;
}

export async function stopClient() {
    const current = client;
    client = null;
    if (!current) return;
    listeners.forEach((listener) => listener(null));
    try {
        // destroy() also stops the update loop that disconnect() leaves running
        await current.destroy();
    } catch (e) {
        console.log(e);
    }
}

export function sessionString(c = client) {
    return c?.session.save() ?? "";
}

/**
 * Read a session left in localStorage by the old StoreSession build, so an
 * existing login can move into the vault without a new OTP.
 *
 * store2 kept each value JSON-encoded under ":<name>"; the auth key went in as
 * a serialised Buffer ({ type: "Buffer", data: [...] }).
 */
export async function legacySession() {
    try {
        const read = (name) =>
            JSON.parse(localStorage.getItem(`:${name}`) ?? "null");
        const authKey = read("authKey");
        const dcId = read("dcId");
        const serverAddress = read("serverAddress");
        const port = read("port");
        if (!authKey?.data || !dcId || !serverAddress || !port) return null;

        const session = new StringSession("");
        session.setDC(dcId, serverAddress, port);
        const key = new AuthKey();
        await key.setKey(Buffer.from(authKey.data));
        session.authKey = key;
        return session.save() || null;
    } catch (e) {
        console.log(e);
        return null;
    }
}

/** Drop every key the old StoreSession wrote, once the vault has the session. */
export function clearLegacySession() {
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith(":")) localStorage.removeItem(key);
        }
    } catch {
        // storage blocked: nothing could have been stored there either
    }
}

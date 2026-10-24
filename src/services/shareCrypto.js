/**
 * Encryption for share links (see server/shares.js).
 *
 * Each share has its own random AES-256-GCM key, carried only in the link's
 * #fragment. The file is cut into fixed-size chunks so it can be uploaded and
 * fetched in pieces; chunk n is sealed with an IV that is simply n, which is
 * safe because the key is never used for another file, and which also stops a
 * server from serving chunks out of order. The name, type and exact size go
 * in a separate meta blob under a random IV whose first byte is 1, so it can
 * never collide with a chunk IV.
 *
 * Only WebCrypto, so the same file runs under Node's test runner.
 */
import { fromBase64, toBase64 } from "./crypto.js";

const subtle = globalThis.crypto.subtle;

const toBase64Url = (bytes) =>
    toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (text) =>
    fromBase64(
        text.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (text.length % 4)) % 4),
    );

/** A fresh key, plus the text form that goes after the # in the link. */
export async function newShareKey() {
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const key = await subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
    ]);
    return { key, secret: toBase64Url(raw) };
}

export async function importShareKey(secret) {
    const raw = fromBase64Url(secret);
    if (raw.length !== 32) throw new Error("bad share key");
    return subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
    ]);
}

function chunkIv(index) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(8, index);
    return iv;
}

export async function encryptChunk(key, index, bytes) {
    return new Uint8Array(
        await subtle.encrypt(
            { name: "AES-GCM", iv: chunkIv(index) },
            key,
            bytes,
        ),
    );
}

export async function decryptChunk(key, index, bytes) {
    return new Uint8Array(
        await subtle.decrypt(
            { name: "AES-GCM", iv: chunkIv(index) },
            key,
            bytes,
        ),
    );
}

export async function encryptMeta(key, meta) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    iv[0] = 1;
    const ct = await subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(meta)),
    );
    return { iv: toBase64(iv), ct: toBase64(ct) };
}

export async function decryptMeta(key, blob) {
    const iv = fromBase64(blob.iv);
    if (iv[0] !== 1) throw new Error("bad meta iv");
    const plain = await subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        fromBase64(blob.ct),
    );
    return JSON.parse(new TextDecoder().decode(plain));
}

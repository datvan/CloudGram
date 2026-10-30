/**
 * Telegram's own encryption of what it sends, undone in Web Workers.
 *
 * Every message from Telegram is AES-256-IGE encrypted, and GramJS undoes it
 * in plain JavaScript on the page's one thread, at about 26 MB/s. A download
 * spent half its time there, so 1, 3 or 6 connections all topped out at the
 * same ~140 Mbps: they were queued behind the same thread. Here the file
 * parts go to workers instead, so connections decrypt side by side, while
 * small messages (updates, acknowledgements) stay where they were, since
 * sending them over costs more than it saves.
 *
 * GramJS has no hook for this, so one method of its MTProtoState is replaced
 * by a copy of the 2.17.9 original that differs only in where the IGE runs.
 * Any other GramJS version keeps its own, and a worker that fails or does not
 * answer falls back to decrypting here, so the worst case is the old speed.
 */
import { Buffer } from "buffer/";
import { errors, helpers, version } from "telegram";
import { IGE } from "telegram/crypto/IGE";
import { BinaryReader } from "telegram/extensions";
import { MTProtoState } from "telegram/network/MTProtoState";
import { TLMessage } from "telegram/tl/core";

// the GramJS whose decryptMessageData the copy below was taken from: 2.17.9,
// which still reports itself as 2.17.8 (package.json pins it exactly)
const FOR_VERSION = "2.17.8";
// below this a message is decrypted here: the round trip would cost more
const TO_WORKER = 64 * 1024;
// a worker that takes longer than this is given up on
const WORKER_TIMEOUT = 10_000;
const POOL_SIZE = Math.max(
    1,
    Math.min(4, (navigator.hardwareConcurrency || 2) - 1),
);

let pool = null;
let broken = false;
let nextId = 0;

function startPool() {
    pool = [];
    for (let i = 0; i < POOL_SIZE; i += 1) {
        const worker = new Worker(
            new URL("../utils/igeWorker.js", import.meta.url),
            { type: "module" },
        );
        const slot = { worker, pending: new Map() };
        worker.onmessage = ({ data }) => {
            const job = slot.pending.get(data.id);
            if (!job) return;
            slot.pending.delete(data.id);
            clearTimeout(job.timer);
            if (data.error) job.reject(new Error(data.error));
            else job.resolve(data.out);
        };
        worker.onerror = () => giveUp(new Error("Decrypt worker failed"));
        pool.push(slot);
    }
}

/** Stop using workers for the rest of the visit; what waits on them is decrypted here. */
function giveUp(error) {
    broken = true;
    for (const slot of pool ?? []) {
        for (const job of slot.pending.values()) {
            clearTimeout(job.timer);
            job.reject(error);
        }
        slot.worker.terminate();
    }
    pool = null;
}

function inWorker(body, key, iv) {
    if (!pool) {
        try {
            startPool();
        } catch (error) {
            giveUp(error);
            throw error;
        }
    }
    // the least busy, so connections decrypting at once land on different ones
    const slot = pool.reduce((a, b) =>
        b.pending.size < a.pending.size ? b : a,
    );
    const id = nextId++;
    // a copy of its own, since handing it over empties it on this side
    const data = Uint8Array.from(body);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => giveUp(new Error("Decrypt worker timed out")),
            WORKER_TIMEOUT,
        );
        slot.pending.set(id, { resolve, reject, timer });
        try {
            slot.worker.postMessage({ id, body: data, key, iv }, [data.buffer]);
        } catch (error) {
            giveUp(error);
        }
    });
}

async function decryptIge(body, key, iv) {
    if (body.length >= TO_WORKER && !broken && typeof Worker !== "undefined") {
        try {
            return Buffer.from(await inWorker(body, key, iv));
        } catch (error) {
            console.log("Decrypting here instead", error);
        }
    }
    return new IGE(key, iv).decryptIge(body);
}

// GramJS 2.17.9's MTProtoState.decryptMessageData, but for the IGE line
async function decryptMessageData(body) {
    if (!this.authKey) {
        throw new Error("Auth key unset");
    }
    if (body.length < 8) {
        throw new errors.InvalidBufferError(body);
    }
    const keyId = helpers.readBigIntFromBuffer(body.slice(0, 8));
    if (!this.authKey.keyId || keyId.neq(this.authKey.keyId)) {
        throw new errors.SecurityError(
            "Server replied with an invalid auth key",
        );
    }
    const authKey = this.authKey.getKey();
    if (!authKey) {
        throw new errors.SecurityError("Unset AuthKey");
    }
    const msgKey = body.slice(8, 24);
    const { iv, key } = await this._calcKey(authKey, msgKey, false);
    body = await decryptIge(body.slice(24), key, iv);
    // https://core.telegram.org/mtproto/security_guidelines
    // Sections "checking sha256 hash" and "message length"
    const ourKey = await helpers.sha256(
        Buffer.concat([authKey.slice(96, 96 + 32), body]),
    );
    if (!msgKey.equals(ourKey.slice(8, 24))) {
        throw new errors.SecurityError(
            "Received msg_key doesn't match with expected one",
        );
    }
    const reader = new BinaryReader(body);
    reader.readLong(); // removeSalt
    reader.readLong(); // the session id, which GramJS does not check either
    const remoteMsgId = reader.readLong();
    if (this.msgIds.includes(remoteMsgId.toString()) && this.securityChecks) {
        throw new errors.SecurityError("Duplicate msgIds");
    }
    if (this.msgIds.length > 500) {
        this.msgIds.shift();
    }
    this.msgIds.push(remoteMsgId.toString());
    const remoteSequence = reader.readInt();
    reader.readInt(); // msgLen for the inner object, padding ignored
    const obj = reader.tgReadObject();
    return new TLMessage(remoteMsgId, remoteSequence, obj);
}

/** Put the worker-backed decryption in place, on the GramJS it was written for. */
export function offloadDecryption() {
    if (version !== FOR_VERSION) return false;
    MTProtoState.prototype.decryptMessageData = decryptMessageData;
    return true;
}

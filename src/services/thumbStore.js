import { api } from "./api";
import { decryptBytes, encryptBytes, fromBase64, randomBase64 } from "./crypto";

export const newThumbRef = () =>
    randomBase64(16).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const label = (ref) => `cloudgram-thumb-v1:${ref}`;
export const encryptThumb = (key, ref, bytes) =>
    encryptBytes(key, bytes, label(ref));
export async function decryptThumb(key, ref, blob) {
    try {
        return await decryptBytes(key, blob, label(ref));
    } catch {
        return null;
    }
}
export const putThumbs = (map) => api.putThumbs(map);
export const getThumbs = (ids) => api.getThumbs(ids);
export const deleteThumbs = (ids) => api.deleteThumbs(ids);

let key = null;
let generation = 0;
let timer = null;
const cache = new Map();
const missing = new Set();
const pending = new Map();
let waiting = new Set();
let writeTimer = null;
let writes = [];
let writeFlush = Promise.resolve();
let unavailableUntil = 0;
let forgetTimer = null;
let forgotten = new Set();

export function forgetThumbs(refs) {
    for (const ref of refs) {
        if (!ref) continue;
        if (cache.has(ref)) URL.revokeObjectURL(cache.get(ref));
        cache.delete(ref);
        missing.delete(ref);
        if (key && Date.now() >= unavailableUntil) forgotten.add(ref);
    }
    if (forgotten.size && !forgetTimer) {
        const epoch = generation;
        forgetTimer = setTimeout(async () => {
            forgetTimer = null;
            const ids = [...forgotten];
            forgotten.clear();
            for (let i = 0; i < ids.length; i += 500) {
                if (
                    !key ||
                    epoch !== generation ||
                    Date.now() < unavailableUntil
                )
                    break;
                try {
                    await deleteThumbs(ids.slice(i, i + 500));
                } catch (error) {
                    if (
                        error?.status === 503 &&
                        error.code === "thumbs_unavailable"
                    )
                        unavailableUntil = Date.now() + 5 * 60 * 1000;
                }
            }
        }, 30);
    }
}

export function storeThumb(input, stats) {
    if (!input || !key || Date.now() < unavailableUntil)
        return Promise.resolve(null);
    try {
        let bytes = input;
        if (typeof input === "string") {
            const match = /^data:([^,]*),(.*)$/s.exec(input);
            if (!match) return Promise.resolve(null);
            bytes = /;base64$/i.test(match[1])
                ? fromBase64(match[2])
                : new TextEncoder().encode(decodeURIComponent(match[2]));
        }
        const ref = newThumbRef();
        return new Promise((resolve) => {
            writes.push({ ref, bytes, resolve, epoch: generation, key, stats });
            if (!writeTimer) writeTimer = setTimeout(flushWrites, 30);
        });
    } catch {
        return Promise.resolve(null);
    }
}

function flushWrites() {
    writeTimer = null;
    const queued = writes;
    writes = [];
    writeFlush = writeFlush.then(() => processWrites(queued));
}

async function processWrites(queued) {
    let offset = 0;
    const maxBytes = 3 * 1024 * 1024;
    async function worker() {
        while (offset < queued.length) {
            const batch = [];
            let size = 0;
            while (offset < queued.length && batch.length < 64) {
                const item = queued[offset];
                const ctSize = 4 * Math.ceil((item.bytes.byteLength + 16) / 3);
                if (batch.length && item.epoch !== batch[0].epoch) break;
                if (batch.length && size + ctSize > maxBytes) break;
                offset++;
                if (ctSize > maxBytes) {
                    item.resolve(null);
                    continue;
                }
                batch.push(item);
                size += ctSize;
            }
            if (!batch.length) continue;
            try {
                if (
                    Date.now() < unavailableUntil ||
                    batch[0].epoch !== generation
                )
                    throw new Error("Thumbnail store unavailable");
                const blobs = await Promise.all(
                    batch.map((item) =>
                        encryptThumb(item.key, item.ref, item.bytes),
                    ),
                );
                if (
                    batch[0].epoch !== generation ||
                    Date.now() < unavailableUntil
                )
                    throw new Error(
                        "Drive changed or thumbnail store unavailable",
                    );
                await putThumbs(
                    Object.fromEntries(
                        batch.map((item, n) => [item.ref, blobs[n]]),
                    ),
                );
                for (const [n, item] of batch.entries()) {
                    if (item.stats && item.epoch === generation)
                        item.stats.bytes += blobs[n].ct.length;
                    item.resolve(item.epoch === generation ? item.ref : null);
                }
            } catch (error) {
                if (
                    error?.status === 503 &&
                    error.code === "thumbs_unavailable"
                )
                    unavailableUntil = Date.now() + 5 * 60 * 1000;
                for (const item of batch) item.resolve(null);
            }
        }
    }
    await Promise.all(Array.from({ length: 3 }, () => worker()));
}

export function setThumbKey(next) {
    generation++;
    clearTimeout(forgetTimer);
    forgetTimer = null;
    forgotten.clear();
    key = next;
    clearTimeout(timer);
    timer = null;
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
    missing.clear();
    for (const entry of pending.values()) entry.resolve(null);
    pending.clear();
    waiting = new Set();
}

async function fetchBatch(ids, epoch, currentKey) {
    try {
        let remaining = ids;
        while (remaining.length) {
            const response = await getThumbs(remaining);
            if (epoch !== generation) return;
            const blobs = response.thumbs ?? {};
            const found = remaining.filter((id) => Object.hasOwn(blobs, id));
            await Promise.all(
                found.map(async (id) => {
                    const bytes = await decryptThumb(currentKey, id, blobs[id]);
                    if (epoch !== generation) return;
                    let url = null;
                    if (bytes) {
                        url = URL.createObjectURL(
                            new Blob([bytes], { type: "image/jpeg" }),
                        );
                        cache.set(id, url);
                        if (cache.size > 500) {
                            const oldest = cache.keys().next().value;
                            URL.revokeObjectURL(cache.get(oldest));
                            cache.delete(oldest);
                        }
                    }
                    pending.get(id)?.resolve(url);
                    pending.delete(id);
                }),
            );
            if (epoch !== generation) return;
            remaining = remaining.filter((id) => !found.includes(id));
            if (!response.more) {
                for (const id of remaining) missing.add(id);
                break;
            }
            if (!found.length) break;
        }
    } catch {
        // Network and server errors can be retried by a later request.
    } finally {
        if (epoch === generation)
            for (const id of ids) {
                pending.get(id)?.resolve(null);
                pending.delete(id);
            }
    }
}

export function thumbUrl(record) {
    const inline =
        record.thumbData ||
        (typeof record.thumbnail === "string" &&
        record.thumbnail.startsWith("data:")
            ? record.thumbnail
            : null);
    if (inline) return Promise.resolve(inline);
    const ref = record.thumbRef;
    if (!ref || !key || missing.has(ref)) return Promise.resolve(null);
    if (cache.has(ref)) {
        const url = cache.get(ref);
        cache.delete(ref);
        cache.set(ref, url);
        return Promise.resolve(url);
    }
    if (pending.has(ref)) return pending.get(ref).promise;
    const entry = {};
    entry.promise = new Promise((resolve) => {
        entry.resolve = resolve;
    });
    pending.set(ref, entry);
    waiting.add(ref);
    if (!timer)
        timer = setTimeout(() => {
            timer = null;
            const ids = [...waiting];
            waiting = new Set();
            for (let i = 0; i < ids.length; i += 200)
                fetchBatch(ids.slice(i, i + 200), generation, key);
        }, 30);
    return entry.promise;
}

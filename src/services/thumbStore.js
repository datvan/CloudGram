import { api } from "./api";
import { decryptBytes, encryptBytes, randomBase64 } from "./crypto";

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

export function setThumbKey(next) {
    generation++;
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

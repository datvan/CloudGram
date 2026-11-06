/**
 * Video streaming, page half (the service worker half is public/sw.js).
 *
 * The player asks for byte ranges; the service worker passes each one here,
 * and the parts it covers are fetched from Telegram (1 MB each, the size
 * upload.getFile is happiest with) and handed back. Parts are kept for a
 * while, so seeking back or watching again does not fetch them twice, and the
 * next ones are fetched ahead of the player, the way YouTube keeps a buffer.
 * Parts the player waits for go before parts fetched ahead.
 */
import { getClient, isOnline, onClientChange } from "./telegram";
import { locate } from "../utils/downloadFile";
import { filePart } from "../utils/transfer";
import { typeOf } from "../utils/thumbnails";

const MB = 1024 * 1024;
const PART = MB;
// parts in each answer; the player asks again for what follows
const ANSWER_PARTS = 2;
// how far ahead of the player parts are fetched, in seconds of video, and
// the bounds of that in parts when the bitrate is known or not
const AHEAD_SECONDS = 40;
const AHEAD_MIN = 6;
const AHEAD_MAX = 48;
// requests to Telegram at once for streaming
const AT_ONCE = 4;
// parts kept in memory across every video
const KEEP_BYTES = 256 * MB;

/** fileId -> Promise of { location, dcId, size, type } */
const files = new Map();
/** fileId -> the name it was opened under, for its type */
const names = new Map();
/** fileId -> bytes a second, once the player knows the duration */
const bitrates = new Map();
/** `${fileId}:${index}` -> { promise, size, task }, oldest use first */
const parts = new Map();
let held = 0;

const urgent = [];
const ahead = [];
let active = 0;

/** Can a video be streamed in this tab (the service worker controls it)? */
export const canStream = () =>
    typeof navigator !== "undefined" &&
    Boolean(navigator.serviceWorker?.controller);

/** The URL a <video> plays `record` from. */
export function streamUrl(record) {
    names.set(record.file_id, record.name);
    return `/stream/${record.file_id}/${encodeURIComponent(record.name)}`;
}

/** Tell how many bytes a second the video takes, to size the read-ahead. */
export function setBitrate(fileId, bytesPerSecond) {
    if (bytesPerSecond > 0) bitrates.set(fileId, bytesPerSecond);
}

function pump() {
    while (active < AT_ONCE) {
        const task = urgent.shift() ?? ahead.shift();
        if (!task) return;
        task.queued = false;
        active += 1;
        task.job()
            .then(task.resolve, task.reject)
            .finally(() => {
                active -= 1;
                pump();
            });
    }
}

function enqueue(job, now) {
    const task = { job, queued: true };
    task.promise = new Promise((resolve, reject) => {
        task.resolve = resolve;
        task.reject = reject;
    });
    (now ? urgent : ahead).push(task);
    pump();
    return task;
}

function info(fileId, fresh = false) {
    if (fresh || !files.has(fileId)) {
        const loading = (async () => {
            const [message] = await getClient().getMessages("me", {
                ids: [fileId],
            });
            const file = message?.media && locate(message.media);
            if (!file)
                throw Object.assign(new Error("missing"), { missing: true });
            const type =
                file.mimeType && file.mimeType !== "application/octet-stream"
                    ? file.mimeType
                    : typeOf({ name: names.get(fileId) ?? "" }) ||
                      "application/octet-stream";
            return { ...file, type };
        })();
        files.set(fileId, loading);
        loading.catch(() => {
            if (files.get(fileId) === loading) files.delete(fileId);
        });
    }
    return files.get(fileId);
}

// a file reference Telegram hands out expires after a while; a fresh copy
// of the message carries a new one
const referenceExpired = (error) =>
    /^FILE_REFERENCE_/.test(error?.errorMessage ?? "");

async function fetchPart(fileId, index) {
    const file = await info(fileId);
    try {
        return await filePart(getClient(), file, index, PART);
    } catch (error) {
        if (!referenceExpired(error)) throw error;
        return filePart(getClient(), await info(fileId, true), index, PART);
    }
}

function trim() {
    for (const [key, entry] of parts) {
        if (held <= KEEP_BYTES) return;
        if (!entry.size) continue;
        parts.delete(key);
        held -= entry.size;
    }
}

function part(fileId, index, now) {
    const key = `${fileId}:${index}`;
    const known = parts.get(key);
    if (known) {
        // most recently used goes last, so trim() drops it last
        parts.delete(key);
        parts.set(key, known);
        // asked ahead of time, needed now: it jumps the line
        if (now && known.task.queued) {
            const at = ahead.indexOf(known.task);
            if (at >= 0) {
                ahead.splice(at, 1);
                urgent.push(known.task);
            }
        }
        return known.promise;
    }
    const entry = { size: 0 };
    entry.task = enqueue(() => fetchPart(fileId, index), now);
    entry.task.fileId = fileId;
    entry.task.index = index;
    entry.promise = entry.task.promise.then(
        (bytes) => {
            if (parts.get(key) === entry) {
                entry.size = bytes.length;
                held += bytes.length;
                trim();
            }
            return bytes;
        },
        (error) => {
            if (parts.get(key) === entry) parts.delete(key);
            throw error;
        },
    );
    parts.set(key, entry);
    return entry.promise;
}

/** fileIds whose fetching failed, so the player can tell a lost connection
 * from a format it cannot play */
const failed = new Set();

/** Did fetching this video fail since it was opened? */
export const streamFailed = (fileId) => failed.has(fileId);

/** The player closed: nothing more is fetched ahead for any video. */
export function stopReadAhead() {
    for (const task of ahead.splice(0)) {
        parts.delete(`${task.fileId}:${task.index}`);
        task.reject(new Error("dropped"));
    }
}

/** Fetch the parts after `last` ahead of the player, dropping stale ones. */
function readAhead(fileId, file, last) {
    const rate = bitrates.get(fileId);
    const wanted = rate
        ? Math.ceil((rate * AHEAD_SECONDS) / PART)
        : AHEAD_MIN * 2;
    const count = Math.min(AHEAD_MAX, Math.max(AHEAD_MIN, wanted));
    const end = Math.min(Math.ceil(file.size / PART) - 1, last + count);
    // the player moved elsewhere: what was queued for the old spot can wait
    // forever, so it goes
    for (let i = ahead.length - 1; i >= 0; i -= 1) {
        const task = ahead[i];
        // another video's parts, or this one's for a spot left behind
        if (task.fileId === fileId && task.index > last && task.index <= end)
            continue;
        ahead.splice(i, 1);
        parts.delete(`${fileId}:${task.index}`);
        task.reject(new Error("dropped"));
    }
    for (let index = last + 1; index <= end; index += 1)
        part(fileId, index, false).catch(() => {});
}

/** The answer to one range the service worker passed on. */
async function answer({ fileId, start, end }) {
    if (!isOnline()) return { error: "offline" };
    let file;
    try {
        file = await info(fileId);
    } catch (error) {
        console.log(error);
        failed.add(fileId);
        return { error: error.missing ? "missing" : "failed" };
    }
    const { size } = file;
    if (start >= size || (end != null && end < start))
        return { error: "range", size };
    const first = Math.floor(start / PART);
    const stop = Math.min(
        size - 1,
        end ?? Infinity,
        (first + ANSWER_PARTS) * PART - 1,
    );
    const last = Math.floor(stop / PART);
    let chunks;
    try {
        const wanted = [];
        for (let index = first; index <= last; index += 1)
            wanted.push(part(fileId, index, true));
        readAhead(fileId, file, last);
        chunks = await Promise.all(wanted);
    } catch (error) {
        console.log(error);
        failed.add(fileId);
        return { error: "failed" };
    }
    const out = new Uint8Array(stop - start + 1);
    let filled = 0;
    chunks.forEach((chunk, i) => {
        const at = (first + i) * PART;
        const from = Math.max(0, start - at);
        const to = Math.min(chunk.length, stop - at + 1);
        if (to > from) {
            out.set(chunk.subarray(from, to), filled);
            filled += to - from;
        }
    });
    const bytes = filled === out.length ? out : out.slice(0, filled);
    failed.delete(fileId);
    return { start, size, type: file.type, bytes: bytes.buffer };
}

/** Start answering the service worker; called once at start-up. */
export function startStreaming() {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    sw.addEventListener("message", (event) => {
        if (event.data?.type !== "cloudgram-stream") return;
        const port = event.ports[0];
        answer(event.data)
            .catch((error) => {
                console.log(error);
                return { error: "failed" };
            })
            .then((reply) =>
                port.postMessage(reply, reply.bytes ? [reply.bytes] : []),
            );
    });
    sw.register("/sw.js").catch((error) =>
        console.log("Video streaming is off:", error),
    );
}

// another account's message ids mean other files
onClientChange((client) => {
    if (client) return;
    files.clear();
    names.clear();
    bitrates.clear();
    failed.clear();
    parts.clear();
    held = 0;
});

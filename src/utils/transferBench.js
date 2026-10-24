/**
 * Dev-only speed benchmark for transfer.js, run from the console as
 * `cgBench`. Loaded by main.jsx under import.meta.env.DEV, never in a build.
 *
 *   await cgBench.verify()                 round trips with SHA-256 checks
 *   cgBench.start({ sizesMB, reps })       timed runs in the background
 *   cgBench.state                          progress and results so far
 *
 * Upload runs stop once the parts are saved, so they leave no messages.
 * verify() and the download runs send real files to Saved Messages, with
 * the caption "cloudgram-bench", and leave them there.
 */
import { CustomFile } from "telegram/client/uploads";

import { getClient } from "../services/telegram";
import { locate } from "./downloadFile";
import { downloadParts, uploadParts } from "./transfer";

const KB = 1024;
const MB = 1024 * KB;

export const UPLOADS = {
    // what the app did before: GramJS's batched upload, 6 parts per batch
    "gramjs-6": { gramjs: true },
    "win-512k-i8": { partSize: 512 * KB, inflight: 8 },
    "win-512k-i16": { partSize: 512 * KB, inflight: 16 },
};

export const DOWNLOADS = {
    // what the app did before
    "512k-i8": { partSize: 512 * KB, inflight: 8 },
    "1m-i8": { partSize: MB, inflight: 8 },
};

function makeFile(bytes, name) {
    const parts = [];
    for (let at = 0; at < bytes; at += 64 * KB) {
        const chunk = new Uint8Array(Math.min(64 * KB, bytes - at));
        crypto.getRandomValues(chunk);
        parts.push(chunk);
    }
    return new File(parts, name, { type: "application/octet-stream" });
}

async function sha256(data) {
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

const mbps = (bytes, ms) => Math.round((bytes / MB / (ms / 1000)) * 10) / 10;

async function upload(name, file) {
    const client = getClient();
    const variant = UPLOADS[name];
    const stats = { waits: [], reconnects: 0 };
    const t0 = performance.now();
    const inputFile = variant.gramjs
        ? await client.uploadFile({
              file: new CustomFile(
                  file.name,
                  file.size,
                  "",
                  file.arrayBuffer(),
              ),
              workers: 6,
          })
        : await uploadParts(client, file, { ...variant, stats });
    const ms = performance.now() - t0;
    return { inputFile, ms, mbps: mbps(file.size, ms), stats };
}

async function download(name, message) {
    const client = getClient();
    const stats = { waits: [], reconnects: 0 };
    const where = locate(message.media);
    const t0 = performance.now();
    const bytes = await downloadParts(client, where, {
        ...DOWNLOADS[name],
        stats,
    });
    const ms = performance.now() - t0;
    return { bytes, ms, mbps: mbps(where.size, ms), stats };
}

async function send(inputFile) {
    return getClient().sendFile("me", {
        file: inputFile,
        forceDocument: true,
        caption: "cloudgram-bench",
    });
}

/** Which hosts the API and transfer connections go to. */
async function hosts() {
    const client = getClient();
    const transfer = await client.getSender(client.session.dcId);
    return {
        homeDc: client.session.dcId,
        main: client._sender?._connection?._ip,
        transfer: transfer._connection?._ip,
    };
}

/**
 * Round trips that must come back byte for byte: under 10 MB (saveFilePart),
 * just over it (saveBigFilePart), a size that is no multiple of a part, and a
 * large file. Each is downloaded with the old and the new settings.
 */
async function verify(
    sizes = [3 * MB + 123, 10 * MB + 1, 37 * MB + 4097, 120 * MB + 7],
) {
    const results = [];
    for (const size of sizes) {
        const file = makeFile(size, `bench-${size}.bin`);
        const want = await sha256(file);
        const up = await upload("win-512k-i16", file);
        const message = await send(up.inputFile);
        const row = { size, messageId: message.id, up: up.mbps };
        for (const name of ["512k-i8", "1m-i8"]) {
            const down = await download(name, message);
            row[name] = (await sha256(down.bytes)) === want ? "ok" : "MISMATCH";
        }
        results.push(row);
    }
    return results;
}

const state = { running: false, log: [], error: null };

// a hidden page has its timers throttled, which GramJS's send loop feels;
// every run records whether the page was hidden at any point
let hiddenSince = 0;
document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenSince ||= performance.now();
});
const visibleThrough = (t0) => !document.hidden && hiddenSince < t0;
const markStart = () => {
    if (!document.hidden) hiddenSince = 0;
    return performance.now();
};

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Medians in MB/s per variant and size, from what has run so far. */
function summary() {
    const table = {};
    for (const r of state.log) {
        if (!r.mbps || !r.visible) continue;
        const key = `${r.kind} ${r.variant}`;
        table[key] ??= {};
        (table[key][`${r.sizeMB}MB`] ??= []).push(r.mbps);
    }
    for (const row of Object.values(table))
        for (const k of Object.keys(row)) row[k] = median(row[k]);
    return table;
}

/**
 * Timed runs, interleaved (A B C, A B C, ...) so a change in the network
 * hits every variant alike. `parallel: 2` runs two uploads at once, as the
 * upload queue does.
 */
function start({
    sizesMB = [8, 50, 200],
    reps = 3,
    uploads = Object.keys(UPLOADS),
    downloads = Object.keys(DOWNLOADS),
    parallel = 1,
} = {}) {
    if (state.running) throw new Error("already running");
    Object.assign(state, { running: true, log: [], error: null });
    (async () => {
        try {
            for (const sizeMB of sizesMB) {
                const files = Array.from({ length: parallel }, (_, i) =>
                    makeFile(sizeMB * MB, `bench-${sizeMB}mb-${i}.bin`),
                );
                for (let rep = 0; rep < reps; rep += 1) {
                    for (const variant of uploads) {
                        const t0 = markStart();
                        const runs = await Promise.all(
                            files.map((f) => upload(variant, f)),
                        );
                        const ms = performance.now() - t0;
                        state.log.push({
                            kind: parallel > 1 ? `up×${parallel}` : "up",
                            variant,
                            sizeMB,
                            rep,
                            mbps: mbps(sizeMB * MB * parallel, ms),
                            waits: runs.flatMap((r) => r.stats.waits),
                            reconnects: runs.reduce(
                                (n, r) => n + r.stats.reconnects,
                                0,
                            ),
                            visible: visibleThrough(t0),
                        });
                    }
                }
                if (!downloads.length || parallel > 1) continue;
                // one real message per size to download from
                const up = await upload("win-512k-i16", files[0]);
                const message = await send(up.inputFile);
                for (let rep = 0; rep < reps; rep += 1) {
                    for (const variant of downloads) {
                        const t0 = markStart();
                        const down = await download(variant, message);
                        state.log.push({
                            kind: "down",
                            variant,
                            sizeMB,
                            rep,
                            mbps: down.mbps,
                            waits: down.stats.waits,
                            reconnects: down.stats.reconnects,
                            visible: visibleThrough(t0),
                        });
                    }
                }
            }
        } catch (error) {
            state.error = String(
                error?.errorMessage ?? error?.message ?? error,
            );
            console.error(error);
        } finally {
            state.running = false;
        }
    })();
    return "started";
}

window.cgBench = { verify, start, summary, hosts, state, UPLOADS, DOWNLOADS };

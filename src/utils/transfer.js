/**
 * Moving file bytes to and from Telegram, many parts in flight at once.
 *
 * GramJS sends file parts over a connection of their own (getSender borrows
 * one per DC, on the "-1" media host), but its upload goes in batches: N
 * parts, wait for all N, then the next N, so one slow part stalls the rest.
 * Here every part that lands starts the next one (Telegram's advice at
 * core.telegram.org/api/files), with 512 KB upload parts. Measured with
 * transferBench.js, that took a single large upload from about 3-4 MB/s to
 * 6-7 MB/s; more connections per DC and bigger download parts did not help,
 * so there is one connection and the knobs stay parameters for the bench.
 * (Extra connections were tried again for downloads, the way Telegram Web
 * opens three: Telegram kept closing them mid-transfer, which stalled a
 * download for half a minute. What held downloads back was decryption on the
 * page's thread, now done in workers: see services/decryptWorkers.js.)
 *
 * Upload parts are read from the File one at a time as they go out, so a
 * large file is never held in memory whole.
 *
 * A part that fails for a passing reason (a dropped connection, a timeout, a
 * server-side error) is sent again on its own, a few times with growing
 * pauses, before the whole transfer gives up; and an upload that does give up
 * can pick up where it stopped (see `resume` on uploadParts).
 */
import { Api, errors, helpers } from "telegram";
import { Buffer } from "buffer/";

const KB = 1024;
const MB = 1024 * KB;
// GramJS's line between saveFilePart and saveBigFilePart
const BIG_FILE = 10 * MB;
// a wait longer than this goes back to the caller, which can show it
const MAX_SILENT_WAIT = 60;
// tries per request; the pauses between them double from half a second, so
// the last one goes out about 15 s after the first failed
const ATTEMPTS = 6;

export const UPLOAD_DEFAULTS = { partSize: 512 * KB, inflight: 16 };
export const DOWNLOAD_DEFAULTS = { partSize: 1 * MB, inflight: 8 };

const premiumWait = (error) =>
    Number(/^FLOOD_PREMIUM_WAIT_(\d+)$/.exec(error?.errorMessage ?? "")?.[1]);

/**
 * Telegram answered and the answer will not change on a second try: a
 * redirect (303, which the download follows itself), a bad request, an auth
 * problem. Everything else, including errors that never reached Telegram, may
 * pass.
 */
export const isFinal = (error) =>
    error instanceof errors.RPCError && error.code >= 300 && error.code < 500;

/**
 * One request on the DC's transfer connection, retried through a dropped
 * connection, passing errors and short waits Telegram asks for. `stats`
 * counts what happened, for the benchmark.
 *
 * The sender is borrowed for every request on purpose: borrowing is what
 * keeps it alive, and GramJS drops it 30 s after it was last lent out, which
 * cut long transfers off midway.
 *
 * client.invoke already sleeps through a FLOOD_WAIT up to its threshold, so
 * one that reaches here is long and is rethrown, as is a long
 * FLOOD_PREMIUM_WAIT; both carry `seconds` so the upload queue can say so.
 */
async function call(client, request, dcId, stats) {
    for (let attempt = 0; ; attempt += 1) {
        const sender = await client.getSender(dcId);
        try {
            return await client.invoke(request, sender);
        } catch (error) {
            const premium = premiumWait(error);
            if (premium) {
                stats.waits.push(premium);
                if (premium <= MAX_SILENT_WAIT && attempt < ATTEMPTS - 1) {
                    await helpers.sleep(premium * 1000);
                    continue;
                }
                error.seconds ??= premium;
                throw error;
            }
            if (error instanceof errors.FloodWaitError) {
                stats.waits.push(error.seconds);
                throw error;
            }
            if (attempt < ATTEMPTS - 1 && !isFinal(error)) {
                if (sender.isConnected()) stats.retries += 1;
                else stats.reconnects += 1;
                await helpers.sleep(500 * 2 ** attempt);
                continue;
            }
            throw error;
        }
    }
}

const newStats = () => ({ waits: [], reconnects: 0, retries: 0 });

/** At most `size` holders at once; the rest wait their turn in order. */
function turns(size) {
    let free = size;
    const waiting = [];
    return {
        take() {
            if (free > 0) {
                free -= 1;
                return Promise.resolve();
            }
            return new Promise((resolve) => waiting.push(resolve));
        },
        give() {
            const next = waiting.shift();
            if (next) next();
            else free += 1;
        },
    };
}

// Upload parts in flight across every file at once. A 2 MB file has only
// four parts, so files going one or two at a time left the connection half
// idle; now several go together and share this many, while a big file on its
// own still gets them all. A part is read from disk only once it has a turn,
// so this also bounds the memory the uploads hold.
const UPLOAD_POOL = 16;
const uploadTurns = turns(UPLOAD_POOL);

// How far back a rate looks, so it neither jumps with every part nor lags a
// change in the connection by long.
const RATE_WINDOW = 3000;

/** Bytes a second through one direction, from the parts that landed lately. */
function rateMeter() {
    const seen = [];
    return {
        add(bytes) {
            seen.push([performance.now(), bytes]);
        },
        rate() {
            const now = performance.now();
            while (seen.length && seen[0][0] <= now - RATE_WINDOW) seen.shift();
            const bytes = seen.reduce((sum, [, n]) => sum + n, 0);
            return (bytes * 1000) / RATE_WINDOW;
        },
    };
}

/** Run `inflight` copies of `lane` and settle when all are done. */
function lanes(inflight, lane) {
    return Promise.all(Array.from({ length: inflight }, lane));
}

// ----- upload ---------------------------------------------------------------

const sentMeter = rateMeter();

/**
 * Bytes a second Telegram confirmed receiving lately, all uploads together.
 * Measured here rather than added up per file: a file whose parts are all
 * out may wait a long while for its message to go, and its last speed is no
 * longer anything the connection is doing.
 */
export const uploadRate = () => sentMeter.rate();

/**
 * Upload a File's bytes and return the InputFile to send it with.
 *
 * `resume`, an object the caller keeps between attempts, remembers the file
 * id and which parts Telegram already has, so trying again after a failure
 * sends only what is missing. Empty it to start over.
 */
export async function uploadParts(client, file, options = {}) {
    const { partSize, inflight } = { ...UPLOAD_DEFAULTS, ...options };
    const { onProgress, stats = newStats(), resume = {} } = options;
    const size = file.size;
    const parts = Math.max(1, Math.ceil(size / partSize));
    const big = size > BIG_FILE;
    const fileId = (resume.fileId ??= helpers.generateRandomLong());
    const done = (resume.done ??= new Set());
    const dcId = client.session.dcId;
    const partBytes = (index) => Math.min(partSize, size - index * partSize);
    let next = 0;
    let sent = [...done].reduce((sum, index) => sum + partBytes(index), 0);
    let failed = false;

    await lanes(inflight, async () => {
        while (next < parts && !failed) {
            const index = next++;
            if (done.has(index)) continue;
            await uploadTurns.take();
            try {
                await sendPart(index);
            } finally {
                uploadTurns.give();
            }
        }
    });

    async function sendPart(index) {
        // another lane failed while this one waited for its turn
        if (failed) return;
        const start = index * partSize;
        const blob = file.slice(start, Math.min(size, start + partSize));
        const bytes = Buffer.from(await blob.arrayBuffer());
        const request = big
            ? new Api.upload.SaveBigFilePart({
                  fileId,
                  filePart: index,
                  fileTotalParts: parts,
                  bytes,
              })
            : new Api.upload.SaveFilePart({
                  fileId,
                  filePart: index,
                  bytes,
              });
        try {
            await call(client, request, dcId, stats);
        } catch (error) {
            failed = true;
            throw error;
        }
        done.add(index);
        sent += bytes.length;
        sentMeter.add(bytes.length);
        onProgress?.(sent / Math.max(1, size));
    }

    const name = file.name;
    return big
        ? new Api.InputFileBig({ id: fileId, parts, name })
        : new Api.InputFile({ id: fileId, parts, name, md5Checksum: "" });
}

// ----- download -------------------------------------------------------------

// Download parts in flight across every file at once, so several files
// fetched together share the connection instead of piling onto it.
const downloadTurns = turns(DOWNLOAD_DEFAULTS.inflight);
const receivedMeter = rateMeter();

/** Bytes a second arriving lately, all downloads together. */
export const downloadRate = () => receivedMeter.rate();

/**
 * Fetch a file's bytes from `location` on `dcId`.
 *
 * Parts may be up to 1 MB as long as each stays inside one 1 MB block, which
 * a part size that divides 1 MB at aligned offsets always does. Rejects on
 * anything unexpected so the caller can fall back to GramJS's own path.
 *
 * The bytes come back as one Uint8Array, unless `write(bytes, offset)` is
 * given: then each part goes there as it lands (a file on disk, for what is
 * too big to hold in memory) and nothing is returned.
 */
export async function downloadParts(
    client,
    { location, dcId, size },
    options = {},
) {
    const { partSize, inflight } = { ...DOWNLOAD_DEFAULTS, ...options };
    const { onProgress, stats = newStats(), write } = options;
    // the bench measures settings one at a time, outside the shared pool
    const pool = options.inflight ? null : downloadTurns;
    if (MB % partSize !== 0) throw new Error("Part size must divide 1 MB");
    const out = write ? null : new Uint8Array(size);
    const parts = Math.ceil(size / partSize);
    let next = 0;
    let done = 0;
    let failed = false;

    async function fetchPart(index) {
        const request = new Api.upload.GetFile({
            location,
            offset: helpers.returnBigInt(index * partSize),
            limit: partSize,
            precise: false,
            cdnSupported: false,
        });
        for (;;) {
            try {
                const result = await call(client, request, dcId, stats);
                if (!(result instanceof Api.upload.File))
                    throw new Error("Unexpected file redirect");
                return result.bytes;
            } catch (error) {
                // the file lives on another data center; every lane follows
                if (error instanceof errors.FileMigrateError) {
                    dcId = error.newDc;
                    continue;
                }
                throw error;
            }
        }
    }

    // once one part fails the rest stop, so the fallback is not left
    // competing with requests whose bytes nobody will read
    await lanes(inflight, async () => {
        while (next < parts && !failed) {
            const index = next++;
            await pool?.take();
            try {
                // another lane failed while this one waited for its turn
                if (failed) return;
                const bytes = await fetchPart(index);
                const expected = Math.min(partSize, size - index * partSize);
                if (bytes.length !== expected)
                    throw new Error(`Part ${index} came back short`);
                receivedMeter.add(bytes.length);
                if (write) await write(bytes, index * partSize);
                else out.set(bytes, index * partSize);
                done += bytes.length;
                onProgress?.(done);
            } catch (error) {
                failed = true;
                throw error;
            } finally {
                pool?.give();
            }
        }
    });
    return out;
}

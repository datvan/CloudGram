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
 *
 * Upload parts are read from the File one at a time as they go out, so a
 * large file is never held in memory whole.
 */
import { Api, errors, helpers } from "telegram";
import { Buffer } from "buffer/";

const KB = 1024;
const MB = 1024 * KB;
// GramJS's line between saveFilePart and saveBigFilePart
const BIG_FILE = 10 * MB;
// a wait longer than this goes back to the caller, which can show it
const MAX_SILENT_WAIT = 60;

export const UPLOAD_DEFAULTS = { partSize: 512 * KB, inflight: 16 };
export const DOWNLOAD_DEFAULTS = { partSize: 1 * MB, inflight: 8 };

const premiumWait = (error) =>
    Number(/^FLOOD_PREMIUM_WAIT_(\d+)$/.exec(error?.errorMessage ?? "")?.[1]);

/**
 * One request on the DC's transfer connection, retried through a dropped
 * connection and through short waits Telegram asks for. `stats` counts what
 * happened, for the benchmark.
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
                if (premium <= MAX_SILENT_WAIT && attempt < 5) {
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
            if (!sender.isConnected() && attempt < 5) {
                stats.reconnects += 1;
                await helpers.sleep(500);
                continue;
            }
            throw error;
        }
    }
}

const newStats = () => ({ waits: [], reconnects: 0 });

/** Run `inflight` copies of `lane` and settle when all are done. */
function lanes(inflight, lane) {
    return Promise.all(Array.from({ length: inflight }, lane));
}

// ----- upload ---------------------------------------------------------------

/** Upload a File's bytes and return the InputFile to send it with. */
export async function uploadParts(client, file, options = {}) {
    const { partSize, inflight } = { ...UPLOAD_DEFAULTS, ...options };
    const { onProgress, stats = newStats() } = options;
    const size = file.size;
    const parts = Math.max(1, Math.ceil(size / partSize));
    const big = size > BIG_FILE;
    const fileId = helpers.generateRandomLong();
    const dcId = client.session.dcId;
    let next = 0;
    let sent = 0;
    let failed = false;

    await lanes(inflight, async () => {
        while (next < parts && !failed) {
            const index = next++;
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
            sent += bytes.length;
            onProgress?.(sent / Math.max(1, size));
        }
    });

    const name = file.name;
    return big
        ? new Api.InputFileBig({ id: fileId, parts, name })
        : new Api.InputFile({ id: fileId, parts, name, md5Checksum: "" });
}

// ----- download -------------------------------------------------------------

/**
 * Fetch a file's bytes from `location` on `dcId`.
 *
 * Parts may be up to 1 MB as long as each stays inside one 1 MB block, which
 * a part size that divides 1 MB at aligned offsets always does. Rejects on
 * anything unexpected so the caller can fall back to GramJS's own path.
 */
export async function downloadParts(
    client,
    { location, dcId, size },
    options = {},
) {
    const { partSize, inflight } = { ...DOWNLOAD_DEFAULTS, ...options };
    const { onProgress, stats = newStats() } = options;
    if (MB % partSize !== 0) throw new Error("Part size must divide 1 MB");
    const out = new Uint8Array(size);
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
            try {
                const bytes = await fetchPart(index);
                const expected = Math.min(partSize, size - index * partSize);
                if (bytes.length !== expected)
                    throw new Error(`Part ${index} came back short`);
                out.set(bytes, index * partSize);
                done += bytes.length;
                onProgress?.(done);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    });
    return out;
}

import { createFile, fileOps } from "../services/drive";
import { getClient } from "../services/telegram";
import { Store } from "../redux/store";
import {
    completedProgress,
    errorProgress,
    queuedProgress,
    retryingProgress,
} from "../redux/actions/progressAction";
import { isFinal } from "./transfer";
import uploadFile from "./uploadFile";

/**
 * One bounded worker pool behind every upload in the app.
 *
 * Parts are read from the file as they go out (transfer.js), so a big file no
 * longer sits in memory whole; two at a time still keeps the connection busy
 * between one file's last part and the next file's first.
 */
const MAX_CONCURRENT = 2;
// pauses before each automatic retry of a whole file, in seconds; once they
// run out the file waits for Retry. Each part has already been tried several
// times by then (transfer.js), so these are for longer outages.
const RETRY_DELAYS = [5, 20, 60];

const waiting = [];
const cancelled = new Set();
/** Jobs that gave up, kept whole so Retry can put them back on the queue. */
const failed = new Map();
let running = 0;

/**
 * Record the file, then line it up behind the pool.
 *
 * The record lands in the tree immediately so the grid can show the file as
 * pending; `file_id` is filled in once the upload finishes.
 */
export function enqueueUpload({ file, parentID, name, asMedia = false }) {
    const record = createFile({
        name: name ?? file.name,
        parent: parentID,
        size: file.size,
        mime: file.type || undefined,
    });
    Store.dispatch(queuedProgress(record.id, record.name));
    waiting.push({ id: record.id, file, asMedia });
    pump();
    return record;
}

/**
 * Give up on uploads whose records are about to disappear.
 *
 * A job already in flight cannot be stopped mid-send, so it is marked here and
 * checked again once it lands.
 */
export function cancelUploads(ids) {
    for (const id of ids) {
        cancelled.add(id);
        failed.delete(id);
    }
}

/**
 * Send a failed upload back to the queue.
 *
 * Without this the only way to recover three bad files out of a folder of five
 * hundred would be to upload the folder again, and since folders merge but
 * files never deduplicate, that would duplicate every file that did work.
 *
 * Only jobs still held in memory can be retried; a reload takes the File object
 * with it, and the progress entry that surfaces this in the UI goes too.
 */
export function retryUpload(id) {
    const job = failed.get(id);
    if (!job) return;
    failed.delete(id);
    job.attempts = 0;
    // no name here: the reducer keeps the one the entry was created with
    Store.dispatch(queuedProgress(id));
    waiting.push(job);
    pump();
}

function pump() {
    while (running < MAX_CONCURRENT && waiting.length) {
        const job = waiting.shift();
        if (cancelled.delete(job.id)) {
            Store.dispatch(completedProgress(job.id));
            continue;
        }
        running += 1;
        run(job).finally(() => {
            running -= 1;
            pump();
        });
    }
}

// Telegram keeps uploaded parts only for a while; lost ones have to go again
const partsLost = (error) =>
    /^FILE_PART_\d+_MISSING$/.test(error?.errorMessage ?? "");

/**
 * How long to wait before trying a failed upload again, or 0 when it should
 * wait for the user instead: Telegram refused the file itself, the message may
 * already be in Saved Messages, or the retries are used up.
 */
function retryDelay(job, error) {
    if (error?.maybeSent || job.attempts >= RETRY_DELAYS.length) return 0;
    // GramJS sleeps through short floods itself and rethrows long ones
    if (error?.seconds) return error.seconds;
    if (isFinal(error) && !partsLost(error)) return 0;
    return RETRY_DELAYS[job.attempts];
}

async function run(job) {
    const { id, file, asMedia } = job;
    // kept on the job, through Retry too, so no attempt resends a part
    // Telegram already has
    job.resume ??= {};
    job.attempts ??= 0;

    let result;
    try {
        // the file is read here, inside the worker, not when it was queued
        result = await uploadFile(id, file, { asMedia, resume: job.resume });
    } catch (error) {
        console.log(error);
        if (partsLost(error)) job.resume = {};
        const seconds = retryDelay(job, error);
        if (!seconds) {
            failed.set(id, job);
            Store.dispatch(
                errorProgress(id, error?.message ?? "Upload failed"),
            );
            return;
        }
        // the slot goes to the next file meanwhile; this one rejoins the
        // back of the line when the pause is over
        job.attempts += 1;
        Store.dispatch(
            retryingProgress(
                id,
                `Lỗi, tự thử lại sau ${seconds} giây (lần ${job.attempts}/${RETRY_DELAYS.length})`,
            ),
        );
        setTimeout(() => {
            waiting.push(job);
            pump();
        }, seconds * 1000);
        return;
    }

    // Deliberately outside the loop above: the file is on Telegram by now, so
    // retrying from here would send a second copy and orphan the first. A
    // failure here is also not offered as a retry, for the same reason.
    try {
        await settle(job, result);
    } catch (error) {
        console.log(error);
        Store.dispatch(
            errorProgress(id, error?.message ?? "Could not save the file id"),
        );
    }
}

/**
 * Attach the message id to the record, unless the record is gone.
 *
 * A record deleted meanwhile is a tombstone now, and writing to it would bring
 * it back under a parent that may no longer exist. By this point the file is
 * already sitting in Saved Messages, so the message has to go instead.
 */
async function settle(job, result) {
    const { id } = job;
    const record = cancelled.delete(id) ? undefined : await fileOps.getByID(id);

    const { message, changes } = result;
    if (record) {
        const extra = { ...changes };
        // Telegram recompressed a PNG photo to JPEG; keep the name honest so
        // a download does not hand back JPEG bytes under a .png name
        if (extra.mime === "image/jpeg" && !/\.jpe?g$/i.test(record.name)) {
            extra.name = record.name.replace(/\.[^.]*$/, "") + ".jpg";
        }
        await fileOps.setFileId(id, message.id, extra);
    } else {
        await getClient().deleteMessages("me", [message.id], {
            revoke: true,
        });
    }

    Store.dispatch(completedProgress(id));
}

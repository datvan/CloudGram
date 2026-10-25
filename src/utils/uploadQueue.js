import { helpers } from "telegram";

import { createFile, fileOps, flush, getRecord } from "../services/drive";
import { getClient } from "../services/telegram";
import {
    dropEntry,
    logEntry,
    patchEntry,
    saveHandle,
    settleWrites,
} from "../services/uploadLog";
import { Store } from "../redux/store";
import {
    completedProgress,
    errorProgress,
    queuedProgress,
    retryingProgress,
} from "../redux/actions/progressAction";
import { isFinal } from "./transfer";
import uploadFile, { sentChanges } from "./uploadFile";

/**
 * One bounded worker pool behind every upload in the app.
 *
 * Parts are read from the file as they go out (transfer.js), so a big file no
 * longer sits in memory whole; two at a time still keeps the connection busy
 * between one file's last part and the next file's first.
 *
 * Every job is also written to the upload log (services/uploadLog.js) until
 * its file_id is safely in the vault, so a closed tab can be resumed.
 */
const MAX_CONCURRENT = 2;
// pauses before each automatic retry of a whole file, in seconds; once they
// run out the file waits for Retry. Each part has already been tried several
// times by then (transfer.js), so these are for longer outages.
const RETRY_DELAYS = [5, 20, 60];
// how often the parts Telegram has are written to the log while uploading
const RESUME_SAVE = 2000;

const waiting = [];
const cancelled = new Set();
/** Jobs that gave up, kept whole so Retry can put them back on the queue. */
const failed = new Map();
/** Every job not finished yet, by record id, so none is queued twice. */
const jobs = new Map();
let running = 0;

// the file id is a big integer, which JSON cannot carry
const saveResume = (resume) =>
    resume?.fileId
        ? { fileId: resume.fileId.toString(), done: [...resume.done] }
        : undefined;
const loadResume = (saved) =>
    saved?.fileId
        ? {
              fileId: helpers.returnBigInt(saved.fileId),
              done: new Set(saved.done),
          }
        : {};

/** Is this record's upload queued or running here (not waiting for Retry)? */
export const isQueued = (id) => jobs.has(id) && !failed.has(id);

/**
 * Record the file, then line it up behind the pool.
 *
 * The record lands in the tree immediately so the grid can show the file as
 * pending; `file_id` is filled in once the upload finishes.
 *
 * A resumed upload passes `recordId` to fill the record it started instead of
 * creating another, and `resume`, the parts saved last time. `source` says
 * where the bytes can be found again after a reload (a Dropbox link, or
 * nothing for a file from this computer), `handle` lets Chrome and Edge reopen
 * the file without a picker, and `path` is where it sat in what was picked.
 */
/** The folders from the root down to a record's parent, as the log keeps them. */
function foldersAbove(record) {
    const chain = [];
    const seen = new Set();
    let folder = record.parent ? getRecord(record.parent) : undefined;
    while (folder && !seen.has(folder.id)) {
        seen.add(folder.id);
        const { id, name, parent, createdAt } = folder;
        chain.unshift({ id, name, parent: parent ?? null, createdAt });
        folder = folder.parent ? getRecord(folder.parent) : undefined;
    }
    return chain;
}

export function enqueueUpload({
    file,
    parentID,
    name,
    asMedia = false,
    recordId,
    resume,
    source,
    handle,
    path,
}) {
    if (recordId && jobs.has(recordId)) {
        // only a job waiting for Retry takes new bytes; a live one is left be
        if (!failed.has(recordId)) return getRecord(recordId);
        failed.delete(recordId);
    }
    const record = recordId
        ? getRecord(recordId)
        : createFile({
              name: name ?? file.name,
              parent: parentID,
              size: file.size,
              mime: file.type || undefined,
          });
    if (!record) return undefined;
    Store.dispatch(queuedProgress(record.id, record.name));
    const job = { id: record.id, file, asMedia, resume: loadResume(resume) };
    jobs.set(record.id, job);
    logEntry(record.id, {
        kind: "file",
        // enough to put the record back if the tree never reached the vault
        record: {
            name: record.name,
            parent: record.parent ?? null,
            size: record.size,
            mime: record.mime,
            createdAt: record.createdAt,
        },
        // and the folders above it, which may not have reached it either
        folders: foldersAbove(record),
        lastModified: file.lastModified,
        path: path ?? record.name,
        asMedia,
        source,
        queuedAt: Date.now(),
        resume: saveResume(job.resume),
    });
    if (handle) saveHandle(record.id, handle);
    waiting.push(job);
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
        dropEntry(id);
    }
}

/**
 * Send a failed upload back to the queue.
 *
 * Without this the only way to recover three bad files out of a folder of five
 * hundred would be to upload the folder again, and since folders merge but
 * files never deduplicate, that would duplicate every file that did work.
 *
 * Only jobs still held in memory can be retried this way; after a reload the
 * resume banner (uploadResume.js) takes over.
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
            jobs.delete(job.id);
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

    let saved = job.resume.done?.size ?? 0;
    const saver = setInterval(() => {
        const done = job.resume.done?.size ?? 0;
        if (done === saved) return;
        saved = done;
        patchEntry(id, { resume: saveResume(job.resume) });
    }, RESUME_SAVE);

    let result;
    try {
        // the file is read here, inside the worker, not when it was queued
        result = await uploadFile(id, file, {
            asMedia,
            resume: job.resume,
            // on disk before the message goes, so a reopened tab knows to
            // look for it in Saved Messages before sending another copy
            onSend: (kind) => {
                patchEntry(id, {
                    resume: saveResume(job.resume),
                    sending: Date.now(),
                    sentAs: kind,
                });
                return settleWrites();
            },
        });
    } catch (error) {
        console.log(error);
        if (partsLost(error)) job.resume = {};
        // Telegram refused it, so nothing went out
        if (!error?.maybeSent)
            patchEntry(id, {
                sending: undefined,
                resume: saveResume(job.resume),
            });
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
    } finally {
        clearInterval(saver);
    }

    // the message exists now; if the tab closes before the vault has its id,
    // the reopened tab attaches this message instead of sending again
    patchEntry(id, { messageId: result.message.id });

    // Deliberately outside the try above: the file is on Telegram by now, so
    // retrying from here would send a second copy and orphan the first. A
    // failure here is also not offered as a retry, for the same reason.
    try {
        await settle(id, result);
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
 *
 * The log entry goes only once the vault has the id: until then it is the
 * one place that still knows which message belongs to the record.
 */
async function settle(id, result) {
    const record = cancelled.delete(id) ? undefined : await fileOps.getByID(id);

    const { message, changes } = result;
    let stored = true;
    if (record) {
        const extra = { ...changes };
        // Telegram recompressed a PNG photo to JPEG; keep the name honest so
        // a download does not hand back JPEG bytes under a .png name
        if (extra.mime === "image/jpeg" && !/\.jpe?g$/i.test(record.name)) {
            extra.name = record.name.replace(/\.[^.]*$/, "") + ".jpg";
        }
        await fileOps.setFileId(id, message.id, extra);
        stored = await flush().then(
            () => true,
            () => false,
        );
    } else {
        await getClient().deleteMessages("me", [message.id], {
            revoke: true,
        });
    }

    jobs.delete(id);
    if (stored) dropEntry(id);
    Store.dispatch(completedProgress(id));
}

/**
 * Give a record the message an earlier, closed tab already sent for it.
 * `kind` is how that tab sent it (photo, video or file).
 */
export function adoptMessage(id, message, kind) {
    return settle(id, {
        message,
        changes: sentChanges(message, kind, getRecord(id)?.size),
    });
}

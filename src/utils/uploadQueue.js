import { v4 as uuid4 } from "uuid";

import client from "../services/telegram";
import { Store } from "../redux/store";
import {
    completedProgress,
    errorProgress,
    queuedProgress,
} from "../redux/actions/progressAction";
import uploadFile from "./uploadFile";

/**
 * One bounded worker pool behind every upload in the app.
 *
 * GramJS buffers a whole file in memory before sending it
 * (uploads.ts: `Buffer.from(await fileToBuffer(file))`), so what kills the tab
 * on a folder upload is memory, not bandwidth. Files are therefore read inside
 * a worker, one or two at a time, never all at once up front.
 */
const MAX_CONCURRENT = 2;
const MAX_FLOOD_RETRIES = 2;

const waiting = [];
const cancelled = new Set();
let running = 0;

/**
 * Record the file, then line it up behind the pool.
 *
 * The record lands in IndexedDB immediately so the grid can show the file as
 * pending; `file_id` is filled in once the upload finishes.
 */
export async function enqueueUpload({ ops, file, parentID, name, onChange }) {
    const record = { id: uuid4(), name: name ?? file.name, type: "file" };
    if (parentID) record.parent = parentID;

    await ops.add(record);
    Store.dispatch(queuedProgress(record.id, record.name));
    waiting.push({ id: record.id, file, ops, onChange });
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
    for (const id of ids) cancelled.add(id);
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

async function run(job) {
    const { id, file, onChange } = job;

    for (let attempt = 0; ; attempt += 1) {
        try {
            // the file is read here, inside the worker, not when it was queued
            const result = await uploadFile(id, file);
            await settle(job, result);
            return;
        } catch (error) {
            // GramJS sleeps through short floods itself and rethrows long ones
            const seconds = error?.seconds;
            if (seconds && attempt < MAX_FLOOD_RETRIES) {
                Store.dispatch(errorProgress(id, `Flood wait ${seconds}s`));
                await new Promise((wake) => setTimeout(wake, seconds * 1000));
                continue;
            }
            console.log(error);
            Store.dispatch(
                errorProgress(id, error?.message ?? "Upload failed"),
            );
            if (onChange) onChange();
            return;
        }
    }
}

/**
 * Attach the message id to the record, unless the record is gone.
 *
 * `update()` is a put, so writing to an id that was deleted meanwhile would
 * resurrect the record under a parent that no longer exists. By this point the
 * file is already sitting in Saved Messages, so the message has to go instead.
 */
async function settle(job, result) {
    const { id, ops, onChange } = job;
    const record = cancelled.delete(id) ? undefined : await ops.getByID(id);

    if (record) {
        await ops.update({ ...record, file_id: result.id });
    } else {
        await client.deleteMessages("me", [result.id], { revoke: true });
    }

    Store.dispatch(completedProgress(id));
    if (onChange) onChange();
}

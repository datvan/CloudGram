/**
 * Storyboards: 81 small frames of a video (9 × 9) in one JPEG, the way
 * YouTube shows a picture over the seek bar. One is made from the local file
 * right after an upload, or else from the stream the first time the video is
 * watched, and kept as a file in Saved Messages. The record notes it as
 * `storyboard: { message, duration }`, so linked copies share it and deleting
 * the video for good deletes it too.
 */
import { useEffect, useState } from "react";

import { getClient, isOnline } from "./telegram";
import { getRecord, getSnapshot, update } from "./drive";
import { fetchFile } from "../utils/downloadFile";
import { uploadParts } from "../utils/transfer";
import { previewKind } from "../components/drive/fileTypes";

export const COLS = 9;
export const FRAMES = COLS * COLS;
// width of one frame; the height follows the video's shape
const FRAME_W = 160;
const QUALITY = 0.7;
// one frame not seeked by then is left out
const SEEK_TIMEOUT = 15000;
// this many frames left out in a row: the stream is stuck, give up
const STUCK = 3;

/** The time frame `index` shows, in a video `duration` seconds long. */
export const frameTime = (index, duration) =>
    ((index + 0.5) * duration) / FRAMES;

/** The frame shown for time `t`. */
export const frameAt = (t, duration) =>
    Math.min(FRAMES - 1, Math.max(0, Math.floor((t / duration) * FRAMES)));

function once(target, event, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`${event} timed out`));
        }, ms);
        const ok = () => {
            cleanup();
            resolve();
        };
        const fail = () => {
            cleanup();
            reject(target.error ?? new Error("video error"));
        };
        const cleanup = () => {
            clearTimeout(timer);
            target.removeEventListener(event, ok);
            target.removeEventListener("error", fail);
        };
        target.addEventListener(event, ok);
        target.addEventListener("error", fail);
    });
}

/** Draw the 81 frames of the video at `src` into one JPEG. */
async function draw(src) {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.src = src;
    try {
        await once(video, "loadedmetadata", 60000);
        const { duration, videoWidth, videoHeight } = video;
        if (!(duration > 0) || !videoWidth || !videoHeight)
            throw new Error("No picture to draw");
        const w = FRAME_W;
        const h = Math.max(1, Math.round((FRAME_W * videoHeight) / videoWidth));
        const canvas = document.createElement("canvas");
        canvas.width = w * COLS;
        canvas.height = h * COLS;
        const context = canvas.getContext("2d");
        let drawn = 0;
        let missed = 0;
        for (let i = 0; i < FRAMES; i += 1) {
            video.currentTime = frameTime(i, duration);
            try {
                await once(video, "seeked", SEEK_TIMEOUT);
                missed = 0;
            } catch (error) {
                if (video.error) throw error;
                missed += 1;
                if (missed >= STUCK) throw new Error("The stream is stuck");
                continue;
            }
            context.drawImage(
                video,
                (i % COLS) * w,
                Math.floor(i / COLS) * h,
                w,
                h,
            );
            drawn += 1;
        }
        if (drawn < FRAMES / 2) throw new Error("Too few frames");
        const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", QUALITY),
        );
        if (!blob) throw new Error("Could not encode the storyboard");
        return { blob, duration };
    } finally {
        video.removeAttribute("src");
        video.load();
    }
}

/** Send the JPEG to Saved Messages as a file, kept byte for byte. */
async function send(blob) {
    const client = getClient();
    const file = new File([blob], "storyboard.jpg", { type: "image/jpeg" });
    const inputFile = await uploadParts(client, file);
    const message = await client.sendFile("me", {
        file: inputFile,
        forceDocument: true,
    });
    return message.id;
}

/** fileId -> Promise of the storyboard field, while one is being made */
const making = new Map();
// file ids that could not be drawn (a format the browser cannot open): not
// tried again in this tab
const failed = new Set();
// one at a time; its stream reads wait behind the player's (stream.js)
let line = Promise.resolve();

function make(fileId, src) {
    if (making.has(fileId)) return making.get(fileId);
    const job = (line = line
        .catch(() => {})
        .then(async () => {
            // made meanwhile, by another tab or the upload
            const done = getSnapshot().records.find(
                (r) => r.file_id === fileId && r.storyboard,
            );
            if (done) return done.storyboard;
            if (!isOnline()) throw new Error("Offline");
            let drawn;
            try {
                drawn = await draw(src());
            } catch (error) {
                // the browser cannot open this video: not tried again
                failed.add(fileId);
                throw error;
            }
            const storyboard = {
                message: await send(drawn.blob),
                duration: drawn.duration,
            };
            // Looked at again: while it was drawn, another tab may have made
            // one, or the video may have been deleted. Then this one would
            // sit in Saved Messages with nothing pointing at it.
            const records = getSnapshot().records.filter(
                (r) => r.file_id === fileId,
            );
            const other = records.find((r) => r.storyboard);
            if (!records.length || other) {
                await getClient()
                    .deleteMessages("me", [storyboard.message], {
                        revoke: true,
                    })
                    .catch((error) => console.log(error));
                if (other) return other.storyboard;
                throw new Error("The video is gone");
            }
            // every record of this video shares it
            for (const r of records) update(r.id, { storyboard });
            return storyboard;
        }));
    making.set(fileId, job);
    job.catch((error) => console.log("No storyboard:", error)).finally(() =>
        making.delete(fileId),
    );
    return job;
}

/** After an upload: draw the storyboard from the file still at hand. */
export function fromUpload(id, file) {
    const record = getRecord(id);
    if (
        !record?.file_id ||
        record.storyboard ||
        previewKind(record) !== "video"
    )
        return;
    const url = URL.createObjectURL(file);
    make(record.file_id, () => url)
        .catch(() => {})
        .finally(() => URL.revokeObjectURL(url));
}

/** message id -> Promise of { url, w, h } */
const loaded = new Map();

function load(record) {
    const { message } = record.storyboard;
    if (!loaded.has(message)) {
        const job = fetchFile(record.id, message, { quiet: true }).then(
            (blob) =>
                new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(blob);
                    const image = new Image();
                    image.onload = () =>
                        resolve({
                            url,
                            w: image.naturalWidth / COLS,
                            h: image.naturalHeight / COLS,
                            duration: record.storyboard.duration,
                        });
                    image.onerror = () => reject(new Error("Bad storyboard"));
                    image.src = url;
                }),
        );
        loaded.set(message, job);
        job.catch(() => loaded.delete(message));
    }
    return loaded.get(message);
}

/**
 * The storyboard of `record` once it is at hand, or null. With `streamSrc`
 * (a function giving a stream URL) and `allowMake`, one is drawn when the
 * video has none yet.
 */
export function useStoryboard(record, streamSrc, allowMake) {
    const [board, setBoard] = useState(null);
    const message = record.storyboard?.message;
    const fileId = record.file_id;
    useEffect(() => {
        setBoard(null);
        if (!fileId) return undefined;
        let cancelled = false;
        const show = (r) =>
            load(r).then(
                (b) => !cancelled && setBoard(b),
                (error) => console.log("Storyboard not loaded:", error),
            );
        if (message) show(record);
        else if (allowMake && streamSrc && !failed.has(fileId))
            make(fileId, streamSrc).then(
                (storyboard) => show({ ...record, storyboard }),
                () => {},
            );
        return () => {
            cancelled = true;
        };
        // the record object changes on every star or rename
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [message, fileId, allowMake]);
    return board;
}

/** Storyboard message ids to delete along with these video messages. */
export function storyboardsOf(records, messageIds) {
    const out = new Set();
    for (const r of records)
        if (r.storyboard && messageIds.has(r.file_id))
            out.add(r.storyboard.message);
    return [...out];
}

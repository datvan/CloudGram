import { Api, errors } from "telegram";

import { getClient } from "../services/telegram";
import { Store } from "../redux/store";
import { uploadProgress } from "../redux/actions/progressAction";
import { fitsAsPhoto, makeThumb, probeVideo } from "./thumbnails";
import { uploadParts } from "./transfer";

// what Telegram itself plays inline; other containers go up as files
const STREAMABLE = ["video/mp4", "video/quicktime", "video/x-m4v"];

/**
 * How to send a file: as a photo or a playable video like the Telegram apps
 * do by default (`asMedia`), or as a file kept byte for byte. A file that
 * Telegram would not take as media falls back to a file.
 */
async function sendOptions(file, asMedia) {
    if (asMedia && (await fitsAsPhoto(file))) {
        return { kind: "photo", options: { forceDocument: false } };
    }
    if (asMedia && STREAMABLE.includes(file.type)) {
        const video = await probeVideo(file);
        if (video) {
            return {
                kind: "video",
                options: {
                    forceDocument: false,
                    supportsStreaming: true,
                    thumb: video.thumb,
                    attributes: [
                        new Api.DocumentAttributeVideo({
                            duration: video.duration,
                            w: video.w,
                            h: video.h,
                            supportsStreaming: true,
                        }),
                    ],
                },
            };
        }
    }
    return {
        kind: "file",
        options: {
            forceDocument: true,
            // lets the grid show pictures without downloading the originals
            thumb: await makeThumb(file),
        },
    };
}

function largestPhotoSize(photo) {
    return Math.max(
        0,
        ...(photo?.sizes ?? []).map((s) =>
            "sizes" in s ? Math.max(...s.sizes) : s.size ?? 0,
        ),
    );
}

/**
 * Send one file to Saved Messages. Resolves to the message plus the record
 * fields the way it was sent changes: a photo is recompressed to JPEG by
 * Telegram, so its stored name, type and size follow what is actually there.
 *
 * Completion is left to the caller: the file still has to be written back to
 * its record, and clearing the progress entry here would make the upload look
 * finished while the record had no file_id yet.
 *
 * The bytes go up through transfer.js, which reads the file part by part,
 * and GramJS only gets the finished InputFile to send. `resume` is handed on
 * to uploadParts, so a second attempt skips the parts already sent.
 *
 * A send that fails without an answer from Telegram may still have gone
 * through, so the error is marked `maybeSent` and the caller should not send
 * again on its own.
 */
/**
 * The record fields a sent message changes. Also used for a message found
 * again after a reload, when the upload that sent it is gone.
 */
export function sentChanges(message, kind, size) {
    const changes = { sentAs: kind };
    if (kind === "photo" && message.media?.photo) {
        changes.mime = "image/jpeg";
        changes.size = largestPhotoSize(message.media.photo) || size;
    }
    return changes;
}

// GramJS refuses a request outright once the client is disconnected (the
// lease went elsewhere), before anything is queued, so nothing went out
const neverQueued = (error) =>
    /^Cannot send requests while disconnected/.test(error?.message ?? "");

// the page hears about a file's progress at most this often; every 512 KB
// part would be a dozen updates a second per file
const PROGRESS_EVERY = 250;

// how far back the upload speed looks, so it neither jumps with every part
// nor lags a change in the connection by long
const SPEED_WINDOW = 3000;

/** Feed it the bytes sent so far; it answers with bytes a second lately. */
function speedMeter() {
    const samples = [];
    return (sent) => {
        const now = performance.now();
        samples.push([now, sent]);
        while (samples.length > 2 && samples[1][0] <= now - SPEED_WINDOW)
            samples.shift();
        const [since, from] = samples[0];
        // a part or two is not enough to say anything
        if (now - since < 500) return undefined;
        return ((sent - from) * 1000) / (now - since);
    };
}

export default async function uploadFile(
    id,
    file,
    { asMedia = false, resume, onSend } = {},
) {
    const { kind, options } = await sendOptions(file, asMedia);
    const client = getClient();

    const speed = speedMeter();
    let told = 0;
    const inputFile = await uploadParts(client, file, {
        resume,
        onProgress: (fraction) => {
            const rate = speed(fraction * file.size);
            const now = performance.now();
            if (fraction < 1 && now - told < PROGRESS_EVERY) return;
            told = now;
            Store.dispatch(uploadProgress(id, fraction * 100, rate));
        },
    });

    // from here a closed tab may leave a message nobody recorded
    await onSend?.(kind);
    let message;
    try {
        message = await client.sendFile("me", {
            file: inputFile,
            ...options,
        });
    } catch (error) {
        if (!(error instanceof errors.RPCError) && !neverQueued(error))
            error.maybeSent = true;
        throw error;
    }

    return { message, changes: sentChanges(message, kind, file.size) };
}

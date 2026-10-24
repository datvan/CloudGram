import { Api } from "telegram";

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
 * and GramJS only gets the finished InputFile to send.
 */
export default async function uploadFile(id, file, { asMedia = false } = {}) {
    const { kind, options } = await sendOptions(file, asMedia);
    const client = getClient();

    const inputFile = await uploadParts(client, file, {
        onProgress: (fraction) =>
            Store.dispatch(uploadProgress(id, fraction * 100)),
    });

    const message = await client.sendFile("me", {
        file: inputFile,
        ...options,
    });

    const changes = { sentAs: kind };
    if (kind === "photo" && message.media?.photo) {
        changes.mime = "image/jpeg";
        changes.size = largestPhotoSize(message.media.photo) || file.size;
    }
    return { message, changes };
}

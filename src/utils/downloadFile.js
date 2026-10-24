import { Api, errors, helpers } from "telegram";

import { getClient } from "../services/telegram";
import {
    completedProgress,
    downloadProgress,
    errorProgress,
} from "../redux/actions/progressAction";
import { Store } from "../redux/store";

// Telegram's largest request; offsets must be multiples of it
const PART = 512 * 1024;
// requests in flight at once. GramJS's own downloadMedia asks for one 128 KB
// part and waits for it before the next, which caps a download at one part
// per round trip (~0.5-1 MB/s) whatever the bandwidth.
const PARALLEL = 8;

/** The full-size copy of a photo: its location type and byte size. */
function largestPhotoSize(photo) {
    let best = null;
    for (const s of photo?.sizes ?? []) {
        const bytes =
            s.className === "PhotoSizeProgressive"
                ? Math.max(...s.sizes)
                : s.className === "PhotoSize"
                ? s.size
                : 0;
        if (bytes && (!best || bytes > best.bytes)) {
            best = { type: s.type, bytes };
        }
    }
    return best;
}

/** Where a message's file lives on Telegram, or null for anything else. */
function locate(media) {
    const doc = media.document;
    if (doc) {
        return {
            location: new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
                thumbSize: "",
            }),
            dcId: doc.dcId,
            size: Number(doc.size?.value ?? doc.size),
            mimeType: doc.mimeType,
        };
    }
    // a file sent as a photo has no document, only scaled copies
    const photo = media.photo;
    const full = largestPhotoSize(photo);
    if (photo && full) {
        return {
            location: new Api.InputPhotoFileLocation({
                id: photo.id,
                accessHash: photo.accessHash,
                fileReference: photo.fileReference,
                thumbSize: full.type,
            }),
            dcId: photo.dcId,
            size: full.bytes,
            mimeType: "image/jpeg",
        };
    }
    return null;
}

/**
 * Fetch a file as PARALLEL concurrent part requests over the connection to
 * the data center that holds it. Rejects on anything unexpected, so the
 * caller can fall back to GramJS's slow but well-trodden path.
 */
async function downloadParallel({ location, dcId, size }, onProgress) {
    const client = getClient();
    const out = new Uint8Array(size);
    const parts = Math.ceil(size / PART);
    let next = 0;
    let done = 0;

    async function fetchPart(index) {
        const offset = index * PART;
        for (;;) {
            try {
                const sender = await client.getSender(dcId);
                const result = await client.invoke(
                    new Api.upload.GetFile({
                        location,
                        offset: helpers.returnBigInt(offset),
                        limit: PART,
                        precise: false,
                        cdnSupported: false,
                    }),
                    sender,
                );
                if (!(result instanceof Api.upload.File)) {
                    throw new Error("Unexpected file redirect");
                }
                return result.bytes;
            } catch (error) {
                // the file lives on another data center; every worker follows
                if (error instanceof errors.FileMigrateError) {
                    dcId = error.newDc;
                    continue;
                }
                throw error;
            }
        }
    }

    let failed = false;
    async function worker() {
        // once one part fails the rest stop, so the fallback is not left
        // competing with requests whose bytes nobody will read
        while (next < parts && !failed) {
            const index = next++;
            try {
                const bytes = await fetchPart(index);
                const expected = Math.min(PART, size - index * PART);
                if (bytes.length !== expected) {
                    throw new Error(`Part ${index} came back short`);
                }
                out.set(bytes, index * PART);
                done += bytes.length;
                onProgress(done);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(PARALLEL, parts) }, worker),
    );
    return out;
}

/**
 * Pull a file's bytes out of Saved Messages, reporting progress under `id`.
 *
 * The whole file is held in memory, so this is only fit for what a tab can
 * hold; the preview refuses anything large before calling it.
 */
export async function fetchFile(id, file_id) {
    Store.dispatch(downloadProgress(id, 0));
    try {
        const message = await getClient().getMessages("me", { ids: file_id });
        const media = message[0]?.media;

        if (!media) {
            // the record points at a message that is no longer there
            throw new Error("File missing on Telegram");
        }

        const file = locate(media);
        const fileSize = Math.max(1, file?.size ?? 1);
        const report = (downloaded) =>
            Store.dispatch(downloadProgress(id, (downloaded / fileSize) * 100));

        let bytes;
        try {
            if (!file) throw new Error("Unknown media");
            bytes = await downloadParallel(file, report);
        } catch (error) {
            console.log("Parallel download failed, retrying slowly", error);
            bytes = await getClient().downloadMedia(media, {
                progressCallback: (downloaded) =>
                    report(Number(downloaded.value ?? downloaded)),
            });
        }
        Store.dispatch(completedProgress(id));
        return new Blob([bytes], { type: file?.mimeType ?? "image/jpeg" });
    } catch (e) {
        // without this the spinner would sit at its last percentage forever
        console.log(e);
        Store.dispatch(errorProgress(id, e?.message ?? "Download failed"));
        throw e;
    }
}

export function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name ?? "download";
    link.click();
    link.remove();
    // revoking straight away can cancel the download in some browsers
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default async function downloadFile(id, file_id, name) {
    try {
        saveBlob(await fetchFile(id, file_id), name);
    } catch {
        // already reported through the progress entry
    }
}

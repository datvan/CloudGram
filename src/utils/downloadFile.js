import { Api } from "telegram";

import { getClient } from "../services/telegram";
import {
    completedProgress,
    downloadProgress,
    errorProgress,
} from "../redux/actions/progressAction";
import { Store } from "../redux/store";
import { downloadParts } from "./transfer";

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
export function locate(media) {
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
            bytes = await downloadParts(getClient(), file, {
                onProgress: report,
            });
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

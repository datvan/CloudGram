import { Api } from "telegram";

import { getRecord } from "../services/drive";
import { getClient } from "../services/telegram";
import {
    completedProgress,
    downloadProgress,
    errorProgress,
} from "../redux/actions/progressAction";
import { Store } from "../redux/store";
import { messagesOf } from "./splitPlan";
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

// Above this a download is written to the browser's private disk area (the
// origin private file system) as it arrives, the way Telegram Web does, rather
// than held whole in memory, which a tab of a few GB cannot do.
const TO_DISK = 64 * 1024 * 1024;
// what an earlier visit left there is cleared a day later, when it is surely
// saved and no longer being written
const STALE = 24 * 60 * 60 * 1000;

async function downloadsFolder() {
    const root = await navigator.storage?.getDirectory?.();
    return root?.getDirectoryHandle("downloads", { create: true });
}

async function clearStale(folder) {
    const now = Date.now();
    for await (const [name, handle] of folder.entries()) {
        try {
            const file = await handle.getFile();
            if (now - file.lastModified > STALE) await folder.removeEntry(name);
        } catch {
            // still being written by another download, or already gone
        }
    }
}

/**
 * A file on disk for the download to land in, or null where the browser
 * has no such place (it is then held in memory as before).
 */
async function diskTarget(id, size) {
    let folder;
    const name = `${id}-${Date.now()}`;
    const remove = () => folder?.removeEntry(name).catch(() => {});
    try {
        folder = await downloadsFolder();
        if (!folder) return null;
        clearStale(folder).catch(() => {});
        const handle = await folder.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        // claims the whole size now, so a full disk shows before any download
        await writable.truncate(size).catch(async (error) => {
            await writable.abort().catch(() => {});
            throw error;
        });
        return {
            write: (bytes, position) =>
                writable.write({ type: "write", position, data: bytes }),
            async finish() {
                await writable.close();
                return handle.getFile();
            },
            abort: () =>
                writable
                    .abort()
                    .catch(() => {})
                    .then(remove),
        };
    } catch (error) {
        remove();
        if (error?.name === "QuotaExceededError") throw error;
        return null;
    }
}

/**
 * Pull a file's bytes out of Saved Messages, reporting progress under `id`
 * unless `quiet` (the viewer fetching the next picture ahead of time).
 *
 * A large file goes to disk as it arrives and comes back as a disk-backed
 * Blob; a small one, or one where the browser has no disk area, is held in
 * memory.
 */
export async function fetchFile(id, file_id, { quiet = false } = {}) {
    const dispatch = quiet ? () => {} : Store.dispatch;
    dispatch(downloadProgress(id, 0));
    try {
        // a cut file is several messages; `file_id` may also be another
        // message of the record (its storyboard), which is just one
        const record = getRecord(id);
        const ids =
            record?.file_id === file_id ? messagesOf(record) : [file_id];
        if (ids.length > 1) {
            const blob = await fetchSlices(id, ids, record.mime, dispatch);
            dispatch(completedProgress(id));
            return blob;
        }
        const message = await getClient().getMessages("me", { ids: file_id });
        const media = message[0]?.media;

        if (!media) {
            // the record points at a message that is no longer there
            throw new Error("File missing on Telegram");
        }

        const file = locate(media);
        const fileSize = Math.max(1, file?.size ?? 1);
        const report = (downloaded) =>
            dispatch(downloadProgress(id, (downloaded / fileSize) * 100));

        const type = file?.mimeType ?? "image/jpeg";
        const disk =
            file && file.size > TO_DISK
                ? await diskTarget(id, file.size)
                : null;
        let data;
        try {
            if (!file) throw new Error("Unknown media");
            if (disk) {
                await downloadParts(getClient(), file, {
                    onProgress: report,
                    write: disk.write,
                });
                data = await disk.finish();
            } else {
                data = await downloadParts(getClient(), file, {
                    onProgress: report,
                });
            }
        } catch (error) {
            if (disk) {
                // GramJS's own download would hold it all in memory, which a
                // file this large is written to disk to avoid
                await disk.abort();
                throw error;
            }
            console.log("Parallel download failed, retrying slowly", error);
            data = await getClient().downloadMedia(media, {
                progressCallback: (downloaded) =>
                    report(Number(downloaded.value ?? downloaded)),
            });
        }
        dispatch(completedProgress(id));
        return new Blob([data], { type });
    } catch (e) {
        // without this the spinner would sit at its last percentage forever
        console.log(e);
        dispatch(errorProgress(id, e?.message ?? "Download failed"));
        throw e;
    }
}

/**
 * A file sent as several messages (uploadFile.js), written one after the
 * other into one file on disk. Needs the disk area: a file this big does not
 * fit in memory.
 */
async function fetchSlices(id, ids, mime, dispatch) {
    const client = getClient();
    const messages = await client.getMessages("me", { ids });
    const files = messages.map((m) => m?.media && locate(m.media));
    if (files.length !== ids.length || files.some((f) => !f))
        throw new Error("File missing on Telegram");
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const disk = await diskTarget(id, total);
    if (!disk)
        throw new Error("Trình duyệt này không tải được tệp lớn như vậy");
    try {
        let base = 0;
        for (const file of files) {
            const start = base;
            await downloadParts(client, file, {
                onProgress: (done) =>
                    dispatch(
                        downloadProgress(id, ((start + done) / total) * 100),
                    ),
                write: (bytes, position) => disk.write(bytes, start + position),
            });
            base += file.size;
        }
        return new Blob([await disk.finish()], {
            type: mime || files[0].mimeType,
        });
    } catch (error) {
        await disk.abort();
        throw error;
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

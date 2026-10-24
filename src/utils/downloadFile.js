import { getClient } from "../services/telegram";
import {
    completedProgress,
    downloadProgress,
    errorProgress,
} from "../redux/actions/progressAction";
import { Store } from "../redux/store";

/**
 * Pull a file's bytes out of Saved Messages, reporting progress under `id`.
 *
 * GramJS buffers the whole file, so this is only fit for what a tab can hold
 * in memory; the preview refuses anything large before calling it.
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

        const fileSize = Number(
            media.document.size.value ?? media.document.size,
        );

        const progressCallback = (downloaded) => {
            const _downloaded = Number(downloaded.value ?? downloaded);
            Store.dispatch(
                downloadProgress(id, (_downloaded / fileSize) * 100),
            );
        };

        const bytes = await getClient().downloadMedia(media, {
            progressCallback,
        });
        Store.dispatch(completedProgress(id));
        return new Blob([bytes], { type: media.document.mimeType });
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

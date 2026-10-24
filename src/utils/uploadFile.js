import { CustomFile } from "telegram/client/uploads";

import { getClient } from "../services/telegram";
import { Store } from "../redux/store";
import { uploadProgress } from "../redux/actions/progressAction";

/**
 * Send one file to Saved Messages.
 *
 * Completion is left to the caller: the file still has to be written back to
 * its record, and clearing the progress entry here would make the upload look
 * finished while the record had no file_id yet.
 *
 * `file.arrayBuffer()` is passed unresolved on purpose; GramJS awaits it
 * (uploads.ts: `Buffer.from(await fileToBuffer(file))`). It does buffer the
 * whole file, which is why uploadQueue runs only a couple at a time.
 */
export default async function uploadFile(id, file) {
    const toUpload = new CustomFile(
        file.name,
        file.size,
        "",
        file.arrayBuffer(),
    );

    function progressCallback(progress) {
        let _progress = progress * 100;
        Store.dispatch(uploadProgress(id, _progress));
    }

    const result = await getClient().sendFile("me", {
        file: toUpload,
        workers: 1,
        forceDocument: true,
        progressCallback,
    });

    return result;
}

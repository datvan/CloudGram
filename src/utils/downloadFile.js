import client from "../services/telegram";
import {
    completedProgress,
    downloadProgress,
    errorProgress,
} from "../redux/actions/progressAction";
import { Store } from "../redux/store";

export default async function downloadFile(id, file_id, name) {
    Store.dispatch(downloadProgress(id, 0));
    try {
        const message = await client.getMessages("me", { ids: file_id });
        const media = message[0]?.media;

        if (!media) {
            // the record points at a message that is no longer there
            Store.dispatch(errorProgress(id, "File missing on Telegram"));
            return;
        }

        const fileSize = Number(media.document.size.value);

        const progressCallback = (downloaded) => {
            const _downloaded = Number(downloaded.value);
            const progress = (_downloaded / fileSize) * 100;
            Store.dispatch(downloadProgress(id, progress));
        };

        const file = await client.downloadMedia(media, { progressCallback });

        //invoke download on browser
        var blob = new Blob([file], { type: media.document.mimeType });
        var url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name ?? "download";
        link.click();
        URL.revokeObjectURL(url);
        link.remove();

        //update completed
        Store.dispatch(completedProgress(id));
    } catch (e) {
        // without this the spinner would sit at its last percentage forever
        console.log(e);
        Store.dispatch(errorProgress(id, e?.message ?? "Download failed"));
    }
}

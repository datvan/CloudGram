import { convertToMp4, needsConvert } from "../../services/convert";
import { getSnapshot, update } from "../../services/drive";
import { uploadEntries } from "../../utils/driveActions";
import { fetchFile } from "../../utils/downloadFile";

// recent previews kept, so flicking back and forth does not re-download; a
// few videos would otherwise hold gigabytes, hence the byte cap too
const KEEP = 10;
const KEEP_BYTES = 150 * 1024 * 1024;
const cache = new Map();
const inflight = new Map();
// the preview on screen, never evicted while it is shown
let pinned = null;

function trim() {
    let bytes = 0;
    for (const entry of cache.values()) bytes += entry.blob.size;
    for (const [id, entry] of cache) {
        if (cache.size <= KEEP && bytes <= KEEP_BYTES) break;
        if (id === pinned) continue;
        URL.revokeObjectURL(entry.url);
        cache.delete(id);
        bytes -= entry.blob.size;
    }
}

function remember(id, entry) {
    const old = cache.get(id);
    if (old && old !== entry) URL.revokeObjectURL(old.url);
    cache.delete(id);
    cache.set(id, entry);
    trim();
}

/** Keep `id` (the preview on screen) whatever else loads; null on close. */
export function pinPreview(id) {
    pinned = id;
    trim();
}

/** What was already fetched for `item`, or undefined. */
export function cachedPreview(item) {
    const entry = cache.get(item.id);
    // a re-upload brings a new message; the old bytes are no longer the file
    if (entry && entry.file_id !== item.file_id) return undefined;
    if (entry) remember(item.id, entry);
    return entry;
}

/**
 * Puts the converted MP4 of `item` next to it on Drive, so the next time it
 * opens straight away. Not when the folder already has a file of that name
 * (an earlier conversion), and never over one. The preview does not wait.
 */
function keepMp4(item, mp4) {
    const name = `${item.name.replace(/\.[^.]+$/, "")}.mp4`;
    const parent = item.parent ?? null;
    const have = getSnapshot().records.some(
        (r) =>
            !r.trashedAt &&
            r.type === "file" &&
            (r.parent ?? null) === parent &&
            r.name.toLowerCase() === name.toLowerCase(),
    );
    if (have) return;
    const file = new File([mp4], name, { type: "video/mp4" });
    const started = Date.now();
    // a failure shows in the transfer panel like any upload
    uploadEntries([file], parent, { onConflict: async () => "skip" })
        .then(() => {
            // its record exists once queued; binning, restoring or deleting
            // the original now takes this one along (drive.withConverted)
            const made = getSnapshot()
                .records.filter(
                    (r) =>
                        r.type === "file" &&
                        (r.parent ?? null) === parent &&
                        r.name === name &&
                        r.createdAt >= started,
                )
                .sort((a, b) => b.createdAt - a.createdAt)[0];
            if (made) update(made.id, { convertedFrom: item.id });
        })
        .catch(() => {});
}

/**
 * The bytes of `item` as `{ blob, url, text }`, fetched once however many
 * ask: the picture on screen and the one fetched ahead of it share a load.
 * `quiet` keeps a fetch ahead of time out of the transfer panel. A video the
 * browser cannot play is converted to MP4 first (`onConvert` reports how far).
 */
export function loadPreview(item, kind, { quiet = false, onConvert } = {}) {
    const ready = cachedPreview(item);
    if (ready) return Promise.resolve(ready);
    const key = `${item.id}:${item.file_id}`;
    if (!inflight.has(key)) {
        inflight.set(
            key,
            fetchFile(item.id, item.file_id, { quiet })
                .then(async (blob) => {
                    if (!needsConvert(item)) return blob;
                    const mp4 = await convertToMp4(blob, item.name, onConvert);
                    keepMp4(item, mp4);
                    return mp4;
                })
                .then(async (blob) => {
                    const typed =
                        kind === "pdf"
                            ? new Blob([blob], { type: "application/pdf" })
                            : blob;
                    const entry = {
                        file_id: item.file_id,
                        blob,
                        url: URL.createObjectURL(typed),
                        text: kind === "text" ? await blob.text() : null,
                    };
                    remember(item.id, entry);
                    return entry;
                })
                .finally(() => inflight.delete(key)),
        );
    }
    return inflight.get(key);
}

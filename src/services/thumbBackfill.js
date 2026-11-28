import { hasClient } from "./telegram";
import { regenerateThumbnail } from "./thumbnailOverride";
import { previewKind } from "../components/drive/fileTypes";
import { Store } from "../redux/store";
import { queuedCount } from "../utils/uploadQueue";
import { diag } from "./diag";

const FAILED_KEY = "cloudgram.thumbBackfill.failed";
const MAKE_LIMIT = 100 * 1024 * 1024;

export function createThumbBackfill({
    regenerate,
    ownsLease,
    uploadsActive,
    isMetered,
    diag,
    storage,
}) {
    const attempted = new Set();
    const pending = new Set();
    const listeners = new Set();
    const queue = [];
    let failed;
    try {
        const saved = JSON.parse(storage?.getItem(FAILED_KEY) || "[]");
        failed = new Set(Array.isArray(saved) ? saved.slice(-2000) : []);
    } catch {
        failed = new Set();
    }
    let running = false;
    let counts = { ok: 0, fail: 0, skipped: 0 };
    let processed = 0;
    const report = () => {
        try {
            diag("thumbs.backfill", counts);
        } catch {
            /* Diagnostics are optional. */
        }
        counts = { ok: 0, fail: 0, skipped: 0 };
        processed = 0;
    };
    async function pump() {
        if (running) return;
        running = true;
        while (queue.length) {
            const record = queue.shift();
            pending.delete(record.id);
            const kind = previewKind(record);
            if (
                attempted.has(record.id) ||
                failed.has(record.id) ||
                !ownsLease() ||
                uploadsActive() ||
                isMetered() ||
                record.type === "folder" ||
                !["image", "video"].includes(kind) ||
                (kind === "image" &&
                    (record.size > MAKE_LIMIT || record.enc?.size > MAKE_LIMIT))
            ) {
                counts.skipped++;
            } else {
                attempted.add(record.id);
                try {
                    await regenerate(record);
                    counts.ok++;
                    for (const listener of listeners) {
                        try {
                            listener(record.id);
                        } catch {
                            /* Listeners are independent. */
                        }
                    }
                } catch {
                    counts.fail++;
                    failed.delete(record.id);
                    failed.add(record.id);
                    if (failed.size > 2000)
                        failed.delete(failed.values().next().value);
                    try {
                        storage?.setItem(
                            FAILED_KEY,
                            JSON.stringify([...failed]),
                        );
                    } catch {
                        /* Storage may be unavailable. */
                    }
                }
            }
            if (++processed === 20) report();
        }
        running = false;
        if (processed) report();
    }
    return {
        request(record) {
            if (!record || record.id == null || pending.has(record.id)) return;
            pending.add(record.id);
            queue.push(record);
            void pump();
        },
        onDone(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}

const thumbBackfill = createThumbBackfill({
    regenerate: regenerateThumbnail,
    ownsLease: () => Store.getState().auth.phase === "ready" && hasClient(),
    uploadsActive: () => queuedCount() > 0,
    isMetered: () =>
        navigator.connection?.saveData === true ||
        navigator.connection?.type === "cellular",
    diag,
    storage: typeof localStorage === "undefined" ? null : localStorage,
});

export default thumbBackfill;

import { batch, getRecord, thumbCandidates, update } from "./drive";
import { diag } from "./diag";
import { storeThumb } from "./thumbStore";
import { queuedCount } from "../utils/uploadQueue";

let generation = 0;
let running = false;

export function stopThumbMigration() {
    generation += 1;
    running = false;
}

export function startThumbMigration() {
    if (running) return;
    running = true;
    const current = ++generation;
    void migrate(current);
}

async function migrate(current) {
    let total = 0;
    const skipped = new Set();
    try {
        while (current === generation) {
            if (queuedCount()) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                continue;
            }
            const candidates = thumbCandidates(skipped);
            if (!candidates.length) {
                diag("thumbs.migrate.done", {
                    n: total,
                    skipped: skipped.size,
                });
                return;
            }
            const started = Date.now();
            const refs = await Promise.all(
                candidates.map(({ value }) => storeThumb(value)),
            );
            if (current !== generation) break;
            if (refs.every((ref) => !ref)) {
                diag("thumbs.migrate.stop", {
                    n: total,
                    skipped: skipped.size,
                    reason: "fail",
                });
                return;
            }
            candidates.forEach(({ id }, index) => {
                if (!refs[index]) skipped.add(id);
            });
            let count = 0;
            batch(
                () => {
                    candidates.forEach(
                        ({ id, thumbData, thumbnail }, index) => {
                            const record = getRecord(id);
                            if (
                                !refs[index] ||
                                !record ||
                                record.thumbRef ||
                                record.thumbData !== thumbData ||
                                record.thumbnail !== thumbnail
                            )
                                return;
                            update(
                                id,
                                {
                                    thumbRef: refs[index],
                                    thumbData: undefined,
                                    thumbnail: undefined,
                                },
                                { preserveModifiedAt: true },
                            );
                            count += 1;
                        },
                    );
                },
                { saveDelay: 3000 },
            );
            total += count;
            diag("thumbs.migrate.batch", {
                n: count,
                ms: Date.now() - started,
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        diag("thumbs.migrate.stop", {
            n: total,
            skipped: skipped.size,
            reason: "closed",
        });
    } finally {
        if (current === generation) running = false;
    }
}

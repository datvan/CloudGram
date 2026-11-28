import { repairProgress } from "../redux/actions/progressAction.js";
import { canRepair } from "./convert.js";

export function createRepairQueue(deps) {
    const pending = [];
    const items = new Map();
    let running;

    async function drainItems() {
        while (pending.length) {
            const item = pending.shift();
            if (item.controller.signal.aborted) {
                items.delete(item.id);
                continue;
            }
            try {
                const record = await deps.getRecord(item.id);
                if (item.controller.signal.aborted) continue;
                if (!record || record.deleted || !canRepair(record)) {
                    deps.dispatch({ type: "REPAIR_SKIPPED", id: item.id });
                    continue;
                }
                deps.dispatch(
                    repairProgress(item.id, "running", {
                        name: record.name,
                    }),
                );
                await deps.repairRecord(record, {
                    signal: item.controller.signal,
                    onProgress: ({ phase, percentage }) => {
                        if (!item.controller.signal.aborted)
                            deps.dispatch(
                                repairProgress(item.id, "running", {
                                    phase,
                                    percentage,
                                }),
                            );
                    },
                });
                if (!item.controller.signal.aborted)
                    deps.dispatch(
                        repairProgress(item.id, "done", { percentage: 100 }),
                    );
            } catch (error) {
                if (!item.controller.signal.aborted)
                    deps.dispatch(
                        repairProgress(item.id, "failed", {
                            message: error.message ?? String(error),
                        }),
                    );
            } finally {
                items.delete(item.id);
            }
        }
    }

    function enqueueRepair(ids) {
        for (const id of ids) {
            if (items.has(id)) continue;
            const item = { id, controller: new AbortController() };
            items.set(id, item);
            pending.push(item);
            deps.dispatch(repairProgress(id, "queued"));
        }
        if (!running && pending.length) {
            running = (async () => {
                do {
                    await drainItems();
                } while (pending.length);
                running = undefined;
            })();
        }
        return running ?? Promise.resolve();
    }

    function cancelRepair(id) {
        const item = items.get(id);
        if (!item || item.controller.signal.aborted) return;
        item.controller.abort();
        deps.dispatch(repairProgress(id, "cancelled"));
    }

    return { enqueueRepair, cancelRepair };
}

let dispatches = Promise.resolve();
const queue = createRepairQueue({
    repairRecord: async (...args) =>
        (await import("./repairVideo.js")).repairRecord(...args),
    getRecord: async (id) => (await import("./drive.js")).getRecord(id),
    dispatch: (action) => {
        dispatches = dispatches.then(async () =>
            (await import("../redux/store.js")).Store.dispatch(action),
        );
    },
});

export const { enqueueRepair, cancelRepair } = queue;

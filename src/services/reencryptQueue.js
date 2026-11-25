import { reencryptProgress } from "../redux/actions/progressAction.js";
import { isEncrypted } from "./fileCrypto.js";

export function createReencryptQueue(deps) {
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
                if (!record || record.deleted || isEncrypted(record)) {
                    deps.dispatch({ type: "REENCRYPT_SKIPPED", id: item.id });
                    continue;
                }
                deps.dispatch(
                    reencryptProgress(item.id, "running", {
                        name: record.name,
                    }),
                );
                const client = await deps.getClient();
                item.controller.signal.throwIfAborted();
                await deps.reencryptRecord(record, {
                    source: client,
                    destination: client,
                    signal: item.controller.signal,
                    onProgress: ({ phase, percentage }) => {
                        if (!item.controller.signal.aborted)
                            deps.dispatch(
                                reencryptProgress(item.id, "running", {
                                    phase,
                                    percentage,
                                }),
                            );
                    },
                });
                if (!item.controller.signal.aborted)
                    deps.dispatch(
                        reencryptProgress(item.id, "done", { percentage: 100 }),
                    );
            } catch (error) {
                if (!item.controller.signal.aborted)
                    deps.dispatch(
                        reencryptProgress(item.id, "failed", {
                            message: error.message ?? String(error),
                        }),
                    );
            } finally {
                items.delete(item.id);
            }
        }
    }

    function enqueueReencrypt(ids) {
        for (const id of ids) {
            if (items.has(id)) continue;
            const item = { id, controller: new AbortController() };
            items.set(id, item);
            pending.push(item);
            deps.dispatch(reencryptProgress(id, "queued"));
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

    function cancelReencrypt(id) {
        const item = items.get(id);
        if (!item || item.controller.signal.aborted) return;
        item.controller.abort();
        deps.dispatch(reencryptProgress(id, "cancelled"));
    }

    return { enqueueReencrypt, cancelReencrypt };
}

let dispatches = Promise.resolve();
const queue = createReencryptQueue({
    reencryptRecord: async (...args) =>
        (await import("./reencrypt.js")).reencryptRecord(...args),
    getRecord: async (id) => (await import("./drive.js")).getRecord(id),
    getClient: async () => (await import("./telegram.js")).getClient(),
    dispatch: (action) => {
        dispatches = dispatches.then(async () =>
            (await import("../redux/store.js")).Store.dispatch(action),
        );
    },
});

export const { enqueueReencrypt, cancelReencrypt } = queue;

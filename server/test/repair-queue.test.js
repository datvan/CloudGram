import test from "node:test";
import assert from "node:assert/strict";
import { createRepairQueue } from "../../src/services/repairQueue.js";

const video = (id) => ({
    id,
    type: "file",
    file_id: id,
    name: `${id}.mp4`,
    size: 10,
});

test("queue deduplicates, skips ineligible records and continues after errors", async () => {
    const actions = [];
    const events = [];
    const records = {
        a: video("a"),
        b: video("b"),
        c: video("c"),
        deleted: { ...video("deleted"), deleted: true },
        invalid: { ...video("invalid"), name: "file.txt" },
    };
    const queue = createRepairQueue({
        getRecord: (id) => records[id],
        dispatch: (action) => actions.push(action),
        repairRecord: async (record, { onProgress }) => {
            events.push(`start ${record.id}`);
            onProgress({ phase: "repair", percentage: 42 });
            await Promise.resolve();
            events.push(`end ${record.id}`);
            if (record.id === "b") throw new Error("broken");
        },
    });
    await queue.enqueueRepair([
        "a",
        "a",
        "missing",
        "deleted",
        "invalid",
        "b",
        "c",
    ]);
    assert.deepEqual(events, [
        "start a",
        "end a",
        "start b",
        "end b",
        "start c",
        "end c",
    ]);
    assert.equal(
        actions.filter((a) => a.id === "a" && a.status === "queued").length,
        1,
    );
    for (const id of ["missing", "deleted", "invalid"])
        assert.ok(
            actions.some((a) => a.id === id && a.type === "REPAIR_SKIPPED"),
        );
    assert.ok(
        actions.some(
            (a) =>
                a.id === "b" && a.status === "failed" && a.message === "broken",
        ),
    );
    assert.ok(
        actions.some(
            (a) => a.id === "c" && a.phase === "repair" && a.percentage === 42,
        ),
    );
    assert.ok(actions.some((a) => a.id === "c" && a.status === "done"));
});

test("cancel aborts running and queued repairs without stopping queue", async () => {
    const actions = [];
    let started;
    const ready = new Promise((resolve) => {
        started = resolve;
    });
    const queue = createRepairQueue({
        getRecord: video,
        dispatch: (action) => actions.push(action),
        repairRecord: (record, { signal }) =>
            record.id === "a"
                ? new Promise((resolve, reject) => {
                      signal.addEventListener("abort", () =>
                          reject(signal.reason),
                      );
                      started();
                  })
                : Promise.resolve(),
    });
    const done = queue.enqueueRepair(["a", "b", "c"]);
    await ready;
    queue.cancelRepair("a");
    queue.cancelRepair("b");
    await done;
    for (const id of ["a", "b"]) {
        assert.ok(actions.some((a) => a.id === id && a.status === "cancelled"));
        assert.ok(
            !actions.some(
                (a) => a.id === id && ["failed", "done"].includes(a.status),
            ),
        );
    }
    assert.ok(actions.some((a) => a.id === "c" && a.status === "done"));
});

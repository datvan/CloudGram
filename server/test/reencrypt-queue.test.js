import test from "node:test";
import assert from "node:assert/strict";
import { createReencryptQueue } from "../../src/services/reencryptQueue.js";
import reducer from "../../src/redux/reducers/progressReducer.js";
import { reencryptProgress } from "../../src/redux/actions/progressAction.js";

test("queue runs sequentially, skips unavailable records and continues after failure", async () => {
    const events = [];
    const actions = [];
    const records = {
        a: { id: "a" },
        b: { id: "b" },
        c: { id: "c" },
        encrypted: { enc: {} },
        deleted: { deleted: true },
    };
    const queue = createReencryptQueue({
        getRecord: (id) => records[id],
        getClient: () => "client",
        dispatch: (action) => actions.push(action),
        reencryptRecord: async (record, options) => {
            events.push(`start ${record.id}`);
            assert.equal(options.source, options.destination);
            options.onProgress({ phase: "read", percentage: 25 });
            await Promise.resolve();
            events.push(`end ${record.id}`);
            if (record.id === "b") throw new Error("broken");
        },
    });
    await queue.enqueueReencrypt([
        "a",
        "encrypted",
        "missing",
        "deleted",
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
    assert.ok(
        actions.some(
            (a) =>
                a.id === "b" && a.status === "failed" && a.message === "broken",
        ),
    );
    assert.ok(actions.some((a) => a.id === "c" && a.status === "done"));
    assert.ok(
        actions.some(
            (a) => a.id === "a" && a.phase === "read" && a.percentage === 25,
        ),
    );
    assert.equal(
        actions.filter((a) => a.type === "REENCRYPT_SKIPPED").length,
        3,
    );
});

test("cancel aborts running item and queue continues", async () => {
    const actions = [];
    let started;
    const ready = new Promise((resolve) => {
        started = resolve;
    });
    const queue = createReencryptQueue({
        getRecord: (id) => ({ id }),
        getClient: () => "client",
        dispatch: (action) => actions.push(action),
        reencryptRecord: (record, { signal }) => {
            if (record.id !== "a") return Promise.resolve();
            return new Promise((resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason));
                started();
            });
        },
    });
    const done = queue.enqueueReencrypt(["a", "b"]);
    await ready;
    queue.cancelReencrypt("a");
    await done;
    assert.ok(actions.some((a) => a.id === "a" && a.status === "cancelled"));
    assert.ok(actions.some((a) => a.id === "b" && a.status === "done"));
    assert.ok(!actions.some((a) => a.id === "a" && a.status === "failed"));
});

test("reducer retains reencrypt status, phase and message", () => {
    let state = reducer(
        undefined,
        reencryptProgress("a", "queued", { name: "file" }),
    );
    state = reducer(
        state,
        reencryptProgress("a", "running", { phase: "upload", percentage: 42 }),
    );
    assert.deepEqual(
        [
            state.activeProgress[0].direction,
            state.activeProgress[0].name,
            state.activeProgress[0].phase,
            state.activeProgress[0].percentage,
        ],
        ["reencrypt", "file", "upload", 42],
    );
    for (const status of ["failed", "cancelled", "done"]) {
        state = reducer(
            state,
            reencryptProgress("a", status, { message: "error" }),
        );
        assert.equal(state.activeProgress[0].status, status);
        assert.equal(state.activeProgress[0].message, "error");
    }
    state = reducer(state, { type: "REENCRYPT_SKIPPED", id: "a" });
    assert.equal(state.activeProgress.length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
    migrateToShared,
    needsMigrationResume,
} from "../../src/services/migrateShared.js";

function fixture(records) {
    const events = [];
    const source = { destroy: async () => events.push("destroy private") };
    const destination = { destroy: async () => events.push("destroy shared") };
    const deps = {
        getClient: () => source,
        openSharedClient: async () => destination,
        getSnapshot: () => ({ records }),
        getTelegramMode: async () => "private",
        reencryptRecord: async (record, options) => {
            events.push([record.id, options.deleteOriginal]);
            Object.assign(record, options.extraChanges);
        },
        adoptTelegram: async (client, mode) => {
            assert.equal(client, destination);
            assert.equal(mode, "shared");
            events.push("adopt");
        },
    };
    return { deps, events, source, destination };
}

test("moves live files sequentially and switches at end", async () => {
    const records = [
        { id: "a", type: "file" },
        { id: "b", type: "file", trashedAt: 1, enc: { key: "old" } },
        { id: "c", type: "folder" },
        { id: "d", type: "file", deleted: true },
        { id: "e", type: "file", tg: "shared" },
    ];
    const f = fixture(records);
    assert.deepEqual(
        await migrateToShared({ deps: f.deps, deleteOriginal: true }),
        { done: 2, failed: [] },
    );
    assert.deepEqual(f.events, [
        ["a", true],
        ["b", true],
        "adopt",
        "destroy private",
    ]);
});

test("failure retains private client and reports error", async () => {
    const f = fixture([
        { id: "a", type: "file" },
        { id: "b", type: "file" },
    ]);
    const move = f.deps.reencryptRecord;
    f.deps.reencryptRecord = async (record, options) => {
        if (record.id === "a") throw new Error("failed");
        await move(record, options);
    };
    assert.deepEqual(await migrateToShared({ deps: f.deps }), {
        done: 1,
        failed: [{ id: "a", message: "failed" }],
    });
    assert.deepEqual(f.events, [["b", false], "destroy shared"]);
});

test("resume detection requires private mode and a live shared file", async () => {
    const records = [{ id: "a", type: "file" }];
    const f = fixture(records);
    assert.equal(await needsMigrationResume(f.deps), false);
    records[0].tg = "shared";
    assert.equal(await needsMigrationResume(f.deps), true);
    f.deps.getTelegramMode = async () => "shared";
    assert.equal(await needsMigrationResume(f.deps), false);
    f.deps.getTelegramMode = async () => null;
    assert.equal(await needsMigrationResume(f.deps), false);
    f.deps.getTelegramMode = async () => "private";
    records[0].deleted = true;
    assert.equal(await needsMigrationResume(f.deps), false);
});

test("cancellation keeps completed markers and does not switch", async () => {
    const records = [
        { id: "a", type: "file" },
        { id: "b", type: "file" },
    ];
    const f = fixture(records);
    const controller = new AbortController();
    const move = f.deps.reencryptRecord;
    f.deps.reencryptRecord = async (...args) => {
        await move(...args);
        controller.abort();
    };
    await assert.rejects(
        migrateToShared({ deps: f.deps, signal: controller.signal }),
        { name: "AbortError" },
    );
    assert.equal(records[0].tg, "shared");
    assert.equal(records[1].tg, undefined);
    assert.deepEqual(f.events, [["a", false], "destroy shared"]);
});

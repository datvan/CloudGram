import test from "node:test";
import assert from "node:assert/strict";
import { reencryptRecord } from "../../src/services/reencrypt.js";

function fixture(record = { id: "a", type: "file", name: "file", file_id: 1 }) {
    let current = { ...record };
    const events = [];
    const other = [];
    const deps = {
        readPlain: async () => {
            events.push("read");
            return "bytes";
        },
        uploadEncrypted: async () => {
            events.push("upload");
            return { message: { id: 10 }, changes: { enc: { key: "new" } } };
        },
        update: (id, changes) => {
            events.push("update");
            current = { ...current, ...changes };
            return current;
        },
        flush: async () => {
            events.push("flush");
        },
        getSnapshot: () => ({ records: [current, ...other] }),
        deleteMessages: async (client, ids) => {
            events.push([client, ids]);
        },
    };
    const run = (options = {}) =>
        reencryptRecord(record, {
            source: "source",
            destination: "destination",
            deps,
            ...options,
        });
    return { deps, events, other, run, current: () => current };
}

test("success saves before deleting old message", async () => {
    const f = fixture();
    await f.run();
    assert.equal(f.current().file_id, 10);
    assert.deepEqual(f.current().enc, { key: "new" });
    assert.deepEqual(f.events, [
        "read",
        "upload",
        "update",
        "flush",
        ["source", [1]],
    ]);
});

test("upload failure keeps original and cleans known uploaded parts", async () => {
    const f = fixture();
    f.deps.uploadEncrypted = async (record, blob, { resume }) => {
        resume.pieces = [{ id: 11 }];
        throw new Error("upload failed");
    };
    await assert.rejects(f.run(), /upload failed/);
    assert.equal(f.current().file_id, 1);
    assert.deepEqual(f.events, ["read", ["destination", [11]]]);
});

test("flush failure restores record and deletes new message", async () => {
    const f = fixture();
    let calls = 0;
    f.deps.flush = async () => {
        if (!calls++) throw new Error("flush failed");
    };
    await assert.rejects(
        f.run({ extraChanges: { tg: "shared" } }),
        /flush failed/,
    );
    assert.equal(f.current().file_id, 1);
    assert.equal(f.current().enc, undefined);
    assert.equal(f.current().tg, undefined);
    assert.deepEqual(f.events.at(-1), ["destination", [10]]);
});

test("encrypted source moves and marker saves with new message", async () => {
    const f = fixture({
        id: "a",
        type: "file",
        file_id: 1,
        enc: { key: "old" },
    });
    await f.run({ extraChanges: { tg: "shared" }, deleteOriginal: false });
    assert.equal(f.current().tg, "shared");
    assert.equal(f.current().file_id, 10);
    assert.deepEqual(f.current().enc, { key: "new" });
});

test("shared old message in trash is retained", async () => {
    const f = fixture();
    f.other.push({ id: "b", file_id: 1, trashedAt: 5 });
    await f.run();
    assert.equal(f.events.some(Array.isArray), false);
});

test("migration deletes private ids despite matching shared ids", async () => {
    const f = fixture({
        id: "a",
        type: "file",
        file_id: 1,
        thumbnail: 2,
        storyboard: { message: 3 },
        thumbData: "inline",
    });
    f.other.push({
        id: "b",
        tg: "shared",
        file_id: 1,
        thumbnail: 2,
        storyboard: { message: 3 },
    });
    await f.run({
        sameTelegram: (r) => r.tg !== "shared",
        deleteOriginalMedia: true,
        extraChanges: {
            tg: "shared",
            thumbnail: undefined,
            storyboard: undefined,
        },
    });
    assert.deepEqual(f.events.at(-1), ["source", [1, 2, 3]]);
    assert.equal(f.current().thumbData, "inline");
    assert.equal(f.current().thumbnail, undefined);
    assert.equal(f.current().storyboard, undefined);
});

test("migration retains referenced media and skips deletion when requested", async () => {
    const record = {
        id: "a",
        type: "file",
        file_id: 1,
        thumbnail: 2,
        storyboard: { message: 3 },
    };
    const f = fixture(record);
    f.other.push({ id: "b", thumbnail: 2, storyboard: { message: 3 } });
    await f.run({
        sameTelegram: (r) => r.tg !== "shared",
        deleteOriginalMedia: true,
        extraChanges: {
            tg: "shared",
            thumbnail: undefined,
            storyboard: undefined,
        },
    });
    assert.deepEqual(f.events.at(-1), ["source", [1]]);
    const g = fixture(record);
    await g.run({
        deleteOriginal: false,
        deleteOriginalMedia: true,
        extraChanges: {
            tg: "shared",
            thumbnail: undefined,
            storyboard: undefined,
        },
    });
    assert.equal(g.events.some(Array.isArray), false);
});

test("split file saves all encrypted parts in one update", async () => {
    const f = fixture({
        id: "a",
        type: "file",
        name: "split",
        file_id: 1,
        parts: [
            { id: 1, size: 2 },
            { id: 2, size: 3 },
        ],
    });
    const parts = [
        { id: 10, size: 2, enc: { key: "a" } },
        { id: 11, size: 3, enc: { key: "b" } },
    ];
    f.deps.uploadEncrypted = async () => ({
        message: { id: 10 },
        messages: [10, 11],
        changes: { parts },
    });
    await f.run();
    assert.deepEqual(f.current().parts, parts);
    assert.equal(f.events.filter((event) => event === "update").length, 1);
    assert.deepEqual(f.events.at(-1), ["source", [1, 2]]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function harness(records, storeThumb) {
    const source = (
        await Promise.all(
            ["treeStore.js", "drive.js", "thumbMigrate.js"].map((name) =>
                readFile(
                    new URL(`../../src/services/${name}`, import.meta.url),
                    "utf8",
                ),
            ),
        )
    )
        .join("\n")
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "")
        .replace(
            "function touch(id) {",
            "function touch(id) { touched(shardOf(id, shardCount));",
        );
    const events = [],
        writes = [],
        batches = [];
    let touchedShards = new Set();
    const context = vm.createContext({
        api: {
            getTree: async () => ({ version: 1, ct: "x", records }),
            putTreeShards: async (body) => {
                writes.push(body);
                return { version: 2 };
            },
        },
        ApiError: class extends Error {},
        uuid4: () => "new",
        diag: (event, data) => {
            events.push({ event, ...data });
            if (event === "thumbs.migrate.batch") {
                batches.push(touchedShards);
                touchedShards = new Set();
            }
        },
        touched: (shard) => touchedShards.add(shard),
        DIAG_LOG: false,
        treeStats() {},
        setThumbKey() {},
        swallow: () => () => {},
        queuedCount: () => 0,
        storeThumb,
        setTimeout: (fn, ms) => (ms === 300 ? setTimeout(fn, 0) : 0),
        clearTimeout,
        encryptJson: async (_, value) => JSON.parse(JSON.stringify(value)),
        decryptJson: async (_, value) => value,
    });
    const drive = vm.runInContext(
        `${source}\n;({ openDrive, closeDrive, flush, update, getRecord, shardOf, startThumbMigration, stopThumbMigration })`,
        context,
    );
    await drive.openDrive({});
    return { drive, events, writes, batches };
}

async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), "migration did not finish");
}

test("migrates inline thumbnails and removes them from saved shard JSON", async () => {
    const h = await harness(
        [{ id: "a", type: "file", thumbData: "data:old", updatedAt: 1 }],
        async () => "ref",
    );
    h.drive.startThumbMigration();
    await until(() => h.events.some((e) => e.event === "thumbs.migrate.done"));
    await h.drive.flush();
    const saved = Object.values(h.writes.at(-1).shards)
        .flatMap((shard) => shard.records)
        .find((r) => r.id === "a");
    assert.equal(saved.thumbRef, "ref");
    assert.equal("thumbData" in saved, false);
    assert.equal(saved.modifiedAt, 1);
});

test("migrates whole shards within 256 candidates per batch", async () => {
    const empty = await harness([], async () => "ref");
    const groups = new Map();
    for (
        let i = 0;
        groups.size < 4 || [...groups.values()].some((g) => g.length < 160);
        i++
    ) {
        const id = `record-${i}`;
        const shard = empty.drive.shardOf(id);
        if (groups.has(shard)) groups.get(shard).push(id);
        else if (groups.size < 4) groups.set(shard, [id]);
    }
    const sizes = [160, 96, 24, 10];
    const selected = [...groups.values()].map((ids, i) =>
        ids.slice(0, sizes[i]),
    );
    const records = [];
    for (let i = 0; i < 160; i++)
        for (const ids of selected)
            if (ids[i])
                records.push({
                    id: ids[i],
                    type: "file",
                    thumbData: "data:old",
                });
    const h = await harness(records, async () => "ref");
    h.drive.startThumbMigration();
    await until(() => h.events.some((e) => e.event === "thumbs.migrate.done"));
    const counts = h.events
        .filter((e) => e.event === "thumbs.migrate.batch")
        .map((e) => e.n);
    assert.deepEqual(counts, [256, 34]);
    const shards = h.batches.flatMap((batch) => [...batch]);
    assert.equal(shards.length, 4);
    assert.equal(new Set(shards).size, 4);
});

test("concurrent edit keeps new inline thumbnail", async () => {
    let resolve;
    const h = await harness(
        [{ id: "a", type: "file", thumbData: "data:old" }],
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    h.drive.startThumbMigration();
    h.drive.update("a", { thumbData: "data:new" });
    resolve("ref");
    await until(() => h.events.some((e) => e.event === "thumbs.migrate.batch"));
    assert.equal(h.drive.getRecord("a").thumbData, "data:new");
    assert.equal(h.drive.getRecord("a").thumbRef, undefined);
    h.drive.closeDrive();
});

test("skips a failed thumbnail and continues into later shards", async () => {
    const empty = await harness([], async () => "ref");
    const groups = new Map();
    for (
        let i = 0;
        groups.size < 2 || [...groups.values()].some((ids) => ids.length < 64);
        i++
    ) {
        const id = `record-${i}`;
        const shard = empty.drive.shardOf(id);
        if (groups.has(shard)) groups.get(shard).push(id);
        else if (groups.size < 2) groups.set(shard, [id]);
    }
    const [first, later] = [...groups.values()];
    const ids = [...first.slice(0, 2), ...later.slice(0, 64)];
    const h = await harness(
        ids.map((id, i) => ({
            id,
            type: "file",
            thumbData: i === 0 ? "data:bad" : "data:good",
        })),
        async (value) => (value === "data:bad" ? null : "ref"),
    );
    h.drive.startThumbMigration();
    await until(() => h.events.some((e) => e.event === "thumbs.migrate.done"));
    assert.equal(h.drive.getRecord(ids[0]).thumbData, "data:bad");
    for (const id of ids.slice(1))
        assert.equal(h.drive.getRecord(id).thumbRef, "ref");
    const done = h.events.find((e) => e.event === "thumbs.migrate.done");
    assert.equal(done.n, 65);
    assert.equal(done.skipped, 1);
    assert.equal(
        h.events.some((e) => e.reason === "fail"),
        false,
    );
});

test("failed batch stops and preserves inline data", async () => {
    const h = await harness(
        [{ id: "a", type: "file", thumbnail: "data:old" }],
        async () => null,
    );
    h.drive.startThumbMigration();
    await until(() => h.events.some((e) => e.reason === "fail"));
    assert.equal(h.drive.getRecord("a").thumbnail, "data:old");
    assert.equal(h.events.find((e) => e.reason === "fail").skipped, 0);
});

test("second start is a no-op and close stops pending work", async () => {
    let resolve,
        calls = 0;
    const h = await harness(
        [{ id: "a", type: "file", thumbData: "data:old" }],
        () => {
            calls++;
            return new Promise((r) => {
                resolve = r;
            });
        },
    );
    h.drive.startThumbMigration();
    h.drive.startThumbMigration();
    assert.equal(calls, 1);
    h.drive.closeDrive();
    resolve("ref");
    await until(() => h.events.some((e) => e.reason === "closed"));
    assert.equal(
        h.events.some((e) => e.event === "thumbs.migrate.batch"),
        false,
    );
});

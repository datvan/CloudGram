import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function harness(initial = { version: 0 }) {
    let state = initial;
    const calls = [];
    let conflict = null;
    let beforeSave = null;
    const source = (
        await Promise.all(
            ["treeStore.js", "drive.js"].map((name) =>
                readFile(
                    new URL(`../../src/services/${name}`, import.meta.url),
                    "utf8",
                ),
            ),
        )
    )
        .join("\n")
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    class ApiError extends Error {
        constructor() {
            super("version_conflict");
            this.status = 409;
            this.code = "version_conflict";
        }
    }
    const api = {
        getTree: async (since = 0) => {
            if (!state.shards || !since) return state;
            return {
                ...state,
                shards: Object.fromEntries(
                    Object.entries(state.shards).filter(
                        ([n]) => state.at[n] > since,
                    ),
                ),
                legacy: undefined,
            };
        },
        putTreeShards: async (body) => {
            calls.push(body);
            if (beforeSave) await beforeSave();
            if (conflict) {
                const run = conflict;
                conflict = null;
                run();
                throw new ApiError();
            }
            if (body.baseVersion !== state.version) throw new ApiError();
            const version = state.version + 1;
            state = {
                version,
                count: body.count,
                shards: { ...state.shards, ...body.shards },
                at: { ...state.at },
            };
            for (const n of Object.keys(body.shards)) state.at[n] = version;
            if (!body.dropLegacy && initial.ct) state.legacy = initial;
            return { version };
        },
    };
    const context = vm.createContext({
        api,
        ApiError,
        uuid4: () => "new",
        diag() {},
        swallow: () => () => {},
        setTimeout: (fn, ms) => (ms === 150 ? setTimeout(fn, 0) : 0),
        clearTimeout,
        encryptJson: async (_, tree) => ({ ...tree, ct: "x" }),
        decryptJson: async (_, blob) => blob,
    });
    const drive = vm.runInContext(
        `${source}\n;({shardOf, groupByShard, saveShards, openDrive, closeDrive, batch, subscribe, getSnapshot, createFile, update, flush, getRecord, isSaved})`,
        context,
    );
    return {
        drive,
        calls,
        get state() {
            return state;
        },
        conflict(run) {
            conflict = () => {
                state = run(state);
            };
        },
        beforeSave(run) {
            beforeSave = run;
        },
    };
}

test("stable hash and legacy migration writes every shard before dropping old tree", async () => {
    const h = await harness({
        version: 1,
        ct: "x",
        records: [{ id: "old", file_id: 7 }],
    });
    assert.equal(h.drive.shardOf("hello"), 171);
    await h.drive.openDrive({});
    await h.drive.flush();
    assert.equal(Object.keys(h.state.shards).length, 512);
    assert.equal(h.calls.at(-1).dropLegacy, true);
    assert.equal(h.drive.isSaved("old"), true);
    h.calls.length = 0;
    h.drive.update("old", { name: "changed" });
    await h.drive.flush();
    assert.equal(Object.keys(h.calls[0].shards).length, 1);
    assert.equal(h.calls[0].dropLegacy, undefined);
});

test("batches stay bounded", async () => {
    const h = await harness();
    const groups = new Map([
        [0, [{ id: "a", value: "a".repeat(4_300_000) }]],
        [1, [{ id: "b", value: "b".repeat(4_300_000) }]],
    ]);
    await h.drive.saveShards({}, { version: 0, count: 2 }, groups);
    assert.equal(h.calls.length, 2);
    for (const call of h.calls)
        assert.ok(JSON.stringify(call).length <= 8 * 1024 * 1024);
});

test("conflict pulls remote change and preserves local edit", async () => {
    const h = await harness();
    await h.drive.openDrive({});
    h.drive.createFile({ name: "local" });
    const index = h.drive.shardOf("remote");
    h.conflict(() => ({
        version: 1,
        count: 512,
        shards: {
            [index]: {
                ct: "x",
                records: [{ id: "remote", name: "remote", updatedAt: 1 }],
            },
        },
        at: { [index]: 1 },
    }));
    await h.drive.flush();
    assert.equal(h.drive.getRecord("new").name, "local");
    assert.equal(h.drive.getRecord("remote").name, "remote");
    assert.equal(h.state.version, 2);
});

test("an edit during a save stays dirty and is not acknowledged early", async () => {
    const h = await harness();
    await h.drive.openDrive({});
    h.drive.createFile({ name: "local" });
    h.drive.update("new", { file_id: 1 });
    let release;
    let started;
    const waiting = new Promise((resolve) => {
        release = resolve;
    });
    const saving = new Promise((resolve) => {
        started = resolve;
    });
    h.beforeSave(async () => {
        h.beforeSave(null);
        started();
        await waiting;
    });
    const first = h.drive.flush();
    await saving;
    h.drive.update("new", { file_id: 2 });
    release();
    await first;
    assert.equal(h.drive.isSaved("new"), false);
    await h.drive.flush();
    assert.equal(h.drive.isSaved("new"), true);
    assert.equal(h.calls.length, 2);
});

test("flush coalesces calls and waits for a follow-up save", async () => {
    const h = await harness();
    await h.drive.openDrive({});
    h.drive.createFile({ id: "a", name: "A" });
    let release, started;
    const waiting = new Promise((resolve) => {
        release = resolve;
    });
    const saving = new Promise((resolve) => {
        started = resolve;
    });
    h.beforeSave(async () => {
        h.beforeSave(null);
        started();
        await waiting;
    });
    const first = h.drive.flush();
    assert.equal(h.drive.flush(), first);
    await saving;
    h.drive.update("a", { file_id: 42 });
    let done = false;
    const follow = h.drive.flush().then(() => {
        done = true;
    });
    h.drive.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(done, false);
    release();
    await Promise.all([first, follow]);
    assert.equal(h.calls.length, 2);
    assert.equal(h.drive.isSaved("a"), true);
});

test("batch publishes once, including nested changes and changes before a throw", async () => {
    const h = await harness();
    await h.drive.openDrive({});
    let publications = 0;
    const unsubscribe = h.drive.subscribe(() => publications++);
    const failure = new Error("batch failure");
    assert.throws(
        () =>
            h.drive.batch(() => {
                h.drive.createFile({ id: "a", name: "A" });
                assert.equal(h.drive.getRecord("a").name, "A");
                assert.equal(h.drive.getSnapshot().records.length, 0);
                h.drive.batch(() => {
                    h.drive.createFile({ id: "b", name: "B" });
                });
                assert.equal(publications, 0);
                h.drive.update("a", { file_id: 123 });
                throw failure;
            }),
        (error) => error === failure,
    );
    assert.equal(publications, 1);
    assert.equal(h.drive.getSnapshot().records.length, 2);
    assert.equal(h.drive.isSaved("a"), false);
    await h.drive.flush();
    assert.equal(h.drive.isSaved("a"), true);
    assert.equal(
        Object.values(h.state.shards).flatMap((shard) => shard.records).length,
        2,
    );
    unsubscribe();
});

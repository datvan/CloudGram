import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = (
    await readFile(
        new URL("../../src/services/treeStore.js", import.meta.url),
        "utf8",
    )
)
    .replace(/^import [\s\S]*?;\r?\n/gm, "")
    .replace(/\bexport /g, "");
const shard = (ct) => ({ iv: "iv", ct });
const snap = (version, shards, count = 2) => ({ version, count, shards });
function harness(initial, replies, broken = false) {
    let cached = initial;
    const calls = [];
    const context = vm.createContext({
        api: {
            getTree: async (since) => {
                calls.push(since);
                return replies.shift();
            },
        },
        readTreeCache: async () => {
            if (broken) throw Error();
            return cached;
        },
        writeTreeCache: async (_, value, { force = false } = {}) => {
            if (broken) throw Error();
            if (force || !(cached?.version > value.version)) cached = value;
        },
        decryptJson: async (_, blob) => {
            if (blob.ct === "bad") throw Error();
            return { records: [blob.ct] };
        },
    });
    return {
        load: vm.runInContext(`${source}\n;loadCachedTree`, context),
        calls,
        get cached() {
            return cached;
        },
    };
}
test("cold and warm loads overlay encrypted shards", async () => {
    const h = harness(null, [snap(1, { 0: shard("old"), 1: shard("keep") })]);
    await h.load({}, "alice");
    assert.deepEqual(h.calls, [0]);
    const warm = harness(h.cached, [snap(2, { 0: shard("new") })]);
    const result = await warm.load({}, "alice");
    assert.deepEqual(warm.calls, [1]);
    assert.deepEqual(Array.from(result.tree.records), ["new", "keep"]);
    assert.equal(result.cache.hit, true);
});
for (const [name, initial, response] of [
    ["bad shape", { version: 1 }, null],
    ["count changed", snap(1, { 0: shard("old") }), snap(2, {}, 3)],
    [
        "legacy",
        snap(1, { 0: shard("old") }),
        { ...snap(2, {}), legacy: shard("legacy") },
    ],
    ["no shards", snap(1, { 0: shard("old") }), { version: 2, ct: "legacy" }],
    ["version decreased", snap(3, { 0: shard("old") }), snap(2, {})],
    ["decrypt failure", snap(1, { 0: shard("bad") }), snap(2, {})],
])
    test(`fallback: ${name}`, async () => {
        const h = harness(initial, [
            ...(response ? [response] : []),
            snap(4, { 0: shard("full") }),
        ]);
        const result = await h.load({}, "alice");
        assert.equal(h.calls.at(-1), 0);
        assert.equal(result.tree.records[0], "full");
        assert.equal(result.cache.hit, false);
    });
test("restored server replaces newer cache before next open", async () => {
    const h = harness(snap(50, { 0: shard("old") }), [
        snap(40, {}),
        snap(40, { 0: shard("restored") }),
        snap(40, {}),
    ]);
    await h.load({}, "alice");
    assert.equal(h.cached.version, 40);
    await h.load({}, "alice");
    assert.deepEqual(h.calls, [50, 0, 40]);
});
test("cache failure does not prevent full load", async () => {
    const h = harness(null, [snap(1, { 0: shard("full") })], true);
    assert.equal((await h.load({}, "alice")).tree.records[0], "full");
});

test("openDrive defers cache diagnostics and ignores stale timers", async () => {
    const driveSource = await readFile(
        new URL("../../src/services/drive.js", import.meta.url),
        "utf8",
    );
    const openSource = driveSource
        .slice(
            driveSource.indexOf("export async function openDrive("),
            driveSource.indexOf("export function closeDrive()"),
        )
        .replace("export ", "");
    const events = [];
    const timers = [];
    const context = vm.createContext({
        setThumbKey() {},
        loadCachedTree: async () => ({
            tree: { version: 1, count: 1, records: [] },
            cache: { hit: true },
        }),
        merge() {},
        noteSaved() {},
        publish() {},
        DIAG_LOG: true,
        diag: (name) => events.push(name),
        treeStats: () => ({ totals: {}, maxima: {} }),
        setTimeout: (callback) => timers.push(callback),
    });
    const open = vm.runInContext(`${openSource}\n;openDrive`, context);
    await open({}, "alice");
    assert.deepEqual(events, []);
    timers.shift()();
    assert.deepEqual(events, ["tree.cache", "tree.stats", "tree.stats.max"]);
    await open({}, "alice");
    await open({}, "bob");
    timers.shift()();
    assert.equal(events.length, 3);
});

test("IndexedDB write guard and account clearing", async () => {
    const cacheSource = (
        await readFile(
            new URL("../../src/services/treeCache.js", import.meta.url),
            "utf8",
        )
    ).replace(/\bexport /g, "");
    const data = new Map();
    const indexedDB = {
        open() {
            const request = {};
            queueMicrotask(() => {
                request.result = {
                    createObjectStore() {},
                    close() {},
                    transaction() {
                        const tx = {
                            objectStore() {
                                return {
                                    get(key) {
                                        const req = {};
                                        queueMicrotask(() => {
                                            req.result = data.get(key);
                                            req.onsuccess();
                                            queueMicrotask(() =>
                                                tx.oncomplete(),
                                            );
                                        });
                                        return req;
                                    },
                                    put(value, key) {
                                        data.set(key, value);
                                    },
                                    delete(key) {
                                        data.delete(key);
                                        queueMicrotask(() => tx.oncomplete());
                                    },
                                };
                            },
                        };
                        return tx;
                    },
                };
                request.onsuccess();
            });
            return request;
        },
    };
    const { readTreeCache, writeTreeCache, clearTreeCache } =
        vm.runInNewContext(
            `${cacheSource}\n;({readTreeCache, writeTreeCache, clearTreeCache})`,
            { indexedDB },
        );
    await writeTreeCache("alice", snap(5, {}));
    await writeTreeCache("alice", snap(3, {}));
    await writeTreeCache("bob", snap(2, {}));
    assert.equal((await readTreeCache("alice")).version, 5);
    await writeTreeCache("alice", snap(3, {}), { force: true });
    assert.equal((await readTreeCache("alice")).version, 3);
    await clearTreeCache("alice");
    assert.equal(await readTreeCache("alice"), undefined);
    assert.equal((await readTreeCache("bob")).version, 2);
});

test("logout clears the active account cache", async () => {
    const accountSource = await readFile(
        new URL("../../src/services/account.js", import.meta.url),
        "utf8",
    );
    const logoutSource = accountSource
        .slice(
            accountSource.indexOf("export async function logout()"),
            accountSource.indexOf("// ----- after the DEK"),
        )
        .replace("export ", "");
    const cleared = [];
    const context = vm.createContext({
        account: { username: "alice" },
        dek: {},
        quickClient: null,
        leasePoll: null,
        stopThumbMigration() {},
        resetReadKey() {},
        closeUploadLog: async () => {},
        flush: async () => {},
        setTimeout,
        clearInterval() {},
        stopHeartbeat() {},
        stopClient: async () => {},
        closeQuickClient: async () => {},
        api: { logout: async () => {} },
        browserId: () => "browser",
        clearKey: async () => {},
        clearTreeCache: async (name) => cleared.push(name),
        closeDrive() {},
        set() {},
        console,
    });
    await vm.runInContext(`${logoutSource}\n;logout()`, context);
    assert.deepEqual(cleared, ["alice"]);
});

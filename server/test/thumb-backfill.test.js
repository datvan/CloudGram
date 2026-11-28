import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (
    await readFile(
        new URL("../../src/services/thumbBackfill.js", import.meta.url),
        "utf8",
    )
)
    .replace(/^import .*;\r?\n/gm, "")
    .split("const thumbBackfill =")[0]
    .replace("export function", "function");
const createThumbBackfill = vm.runInNewContext(
    `${source}\ncreateThumbBackfill`,
    {
        previewKind: (r) =>
            r.name?.endsWith(".jpg")
                ? "image"
                : r.name?.endsWith(".mp4")
                  ? "video"
                  : null,
    },
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const record = (id, extra = {}) => ({
    id,
    file_id: id,
    name: `${id}.jpg`,
    type: "file",
    size: 1,
    ...extra,
});
function harness(overrides = {}) {
    const calls = [],
        events = [],
        done = [];
    const data = new Map();
    const storage = {
        getItem: (key) => data.get(key),
        setItem: (key, value) => data.set(key, value),
    };
    const deps = {
        regenerate: async (r) => calls.push(r.id),
        ownsLease: () => true,
        uploadsActive: () => false,
        isMetered: () => false,
        diag: (event, fields) => events.push([event, { ...fields }]),
        storage,
        ...overrides,
    };
    const queue = createThumbBackfill(deps);
    queue.onDone((id) => done.push(id));
    return { queue, calls, events, done, storage, deps };
}

test("gates skip and allow a later request; filters and once per session", async () => {
    for (const key of ["ownsLease", "uploadsActive", "isMetered"]) {
        let blocked = true;
        const h = harness({
            [key]: () => (key === "ownsLease" ? !blocked : blocked),
        });
        h.queue.request(record(1));
        blocked = false;
        h.queue.request(record(1));
        await tick();
        h.queue.request(record(1));
        await tick();
        assert.deepEqual(h.calls, [1]);
        assert.deepEqual(h.done, [1]);
    }
    const h = harness();
    for (const r of [
        record(1, { type: "folder" }),
        record(2, { name: "a.txt" }),
        record(3, { size: 100 * 1024 * 1024 + 1 }),
        record(4, { enc: { size: 100 * 1024 * 1024 + 1 } }),
    ])
        h.queue.request(r);
    await tick();
    assert.deepEqual(h.calls, []);
});

test("failure persistence prevents reload retry and drops oldest at cap", async () => {
    const h = harness({
        regenerate: async () => {
            throw Error("failed");
        },
    });
    const key = "cloudgram.thumbBackfill.failed";
    h.storage.setItem(
        key,
        JSON.stringify(Array.from({ length: 2000 }, (_, i) => i)),
    );
    const queue = createThumbBackfill(h.deps);
    queue.request(record(2000));
    await tick();
    const saved = JSON.parse(h.storage.getItem(key));
    assert.equal(saved.length, 2000);
    assert.equal(saved[0], 1);
    assert.equal(saved.at(-1), 2000);
    const reload = harness({ storage: h.storage });
    reload.queue.request(record(2000));
    await tick();
    assert.deepEqual(reload.calls, []);
});

test("serial work and diagnostics every 20 and on drain", async () => {
    let release;
    let active = 0,
        maximum = 0;
    const h = harness({
        regenerate: async (r) => {
            active++;
            maximum = Math.max(maximum, active);
            if (r.id === 0)
                await new Promise((resolve) => {
                    release = resolve;
                });
            active--;
            if (r.id === 1) throw Error("failed");
        },
    });
    for (let i = 0; i < 22; i++)
        h.queue.request(record(i, i === 2 ? { name: "x.txt" } : {}));
    assert.equal(active, 1);
    release();
    await tick();
    assert.equal(maximum, 1);
    assert.deepEqual(h.events, [
        ["thumbs.backfill", { ok: 18, fail: 1, skipped: 1 }],
        ["thumbs.backfill", { ok: 2, fail: 0, skipped: 0 }],
    ]);
    assert.equal(h.done.length, 20);
});

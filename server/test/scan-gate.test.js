import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function load(path, result, globals = {}) {
    const source = (await readFile(new URL(path, import.meta.url), "utf8"))
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    return vm.runInNewContext(`${source}\n;(${result})`, {
        DOMException,
        performance,
        Promise,
        ...globals,
    });
}

test("folder scan hands 200 files over and waits before reading further", async () => {
    const { scanProgress, entriesOf } = await load(
        "../../src/utils/pickers.js",
        "({ scanProgress, entriesOf })",
        { uuid4: () => "id" },
    );
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const batches = [];
    let read = 0;
    const root = {
        kind: "directory",
        name: "root",
        async *values() {
            for (let i = 0; i < 401; i += 1)
                yield {
                    kind: "file",
                    name: String(i),
                    getFile: async () => {
                        read += 1;
                        return { size: 1 };
                    },
                };
        },
    };
    const scan = scanProgress(null, (batch) => batches.push(batch.length), {
        gate: () => gate,
    });
    const pending = entriesOf(root, scan);
    while (!batches.length)
        await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(batches, [200]);
    assert.ok(read <= 256);
    release();
    await pending;
    scan.done();
    assert.deepEqual(batches, [200, 200, 1]);
});

test("cancel releases a blocked scan with AbortError", async () => {
    const { scanProgress } = await load(
        "../../src/utils/pickers.js",
        "({ scanProgress })",
    );
    const scan = scanProgress(null, () => {}, {
        gate: () => new Promise(() => {}),
    });
    const pending = scan.wait();
    scan.cancel();
    await assert.rejects(pending, { name: "AbortError" });
});

test("queue wait resolves at threshold", async () => {
    const source = await readFile(
        new URL("../../src/utils/uploadQueue.js", import.meta.url),
        "utf8",
    );
    const code = source
        .slice(
            source.indexOf("let running = 0;"),
            source.indexOf("export const hasActiveUploads"),
        )
        .replace(/\bexport /g, "");
    const queue = vm.runInNewContext(
        `const waiting = []; ${code}; ({ queuedCount, whenQueueBelow, add: () => waiting.push(1), finish: () => { waiting.pop(); notifyQueueWaiters(); } })`,
        { Promise },
    );
    queue.add();
    let resolved = false;
    const pending = queue.whenQueueBelow(0).then(() => {
        resolved = true;
    });
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(queue.queuedCount(), 1);
    queue.finish();
    await pending;
    assert.equal(queue.queuedCount(), 0);
    await queue.whenQueueBelow(0);
});

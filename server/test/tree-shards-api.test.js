import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudGramApi, HttpError, LIMITS } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";

test("shard CAS, validation, migration and deletion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-shards-"));
    try {
        const db = await new Db(dir).open();
        const api = new CloudGramApi({ db, pepper: "x".repeat(40) });
        const id = "a".repeat(32);
        api.authenticate = async () => ({ user: { id } });
        const blob = { iv: "a".repeat(16), ct: "a".repeat(32) };
        const put = (body) => api.putTreeShards({ body }, {});
        const get = (since) => api.getTree({ query: { since } }, {});
        await api.putTree({ body: { tree: blob, baseVersion: 0 } }, {});
        await assert.rejects(
            put({ baseVersion: 1, count: 2, shards: { 2: blob } }),
            { code: "bad_tree" },
        );
        await assert.rejects(
            put({
                baseVersion: 1,
                count: 2,
                shards: {
                    0: {
                        ...blob,
                        ct: "a".repeat(Math.ceil(LIMITS.shardBytes * 1.4) + 1),
                    },
                },
            }),
            { code: "bad_tree" },
        );
        await assert.rejects(
            put({
                baseVersion: 1,
                count: 2,
                shards: { 0: blob },
                dropLegacy: true,
            }),
            { code: "bad_tree" },
        );
        assert.equal(
            (await put({ baseVersion: 1, count: 2, shards: { 0: blob } }))
                .version,
            2,
        );
        assert.ok((await get(0)).legacy);
        await assert.rejects(
            put({ baseVersion: 1, count: 2, shards: { 1: blob } }),
            { code: "version_conflict" },
        );
        await assert.rejects(
            api.putTree({ body: { tree: blob, baseVersion: 2 } }, {}),
            { code: "tree_upgraded" },
        );
        assert.equal(
            (
                await put({
                    baseVersion: 2,
                    count: 2,
                    shards: { 1: blob },
                    dropLegacy: true,
                })
            ).version,
            3,
        );
        const incremental = await get(2);
        assert.deepEqual(Object.keys(incremental.shards), ["1"]);
        assert.equal((await get(0)).legacy, undefined);
        await db.deleteTree(id);
        await assert.rejects(stat(join(dir, "trees", id)), { code: "ENOENT" });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("HTTP streams shards, preserves legacy and aborts on read error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-stream-"));
    const db = await new Db(dir).open();
    const api = new CloudGramApi({ db, pepper: "x".repeat(40) });
    const id = "a".repeat(32);
    let authorized = true;
    api.authenticate = async () => {
        if (!authorized) throw new HttpError(401, "unauthorized");
        return { user: { id } };
    };
    const server = createApiServer(api, {
        log: { error() {} },
        diagLog: false,
    });
    try {
        await new Promise((resolve, reject) =>
            server.listen(0, "127.0.0.1", resolve).once("error", reject),
        );
        const base = `http://127.0.0.1:${server.address().port}/api/vault/tree`;
        const blob = { iv: "a".repeat(16), ct: "b".repeat(32) };
        await api.putTree({ body: { tree: blob, baseVersion: 0 } }, {});
        await api.putTreeShards(
            { body: { baseVersion: 1, count: 2, shards: { 0: blob } } },
            {},
        );
        await api.putTreeShards(
            { body: { baseVersion: 2, count: 2, shards: { 1: blob } } },
            {},
        );
        for (const since of [0, 2]) {
            const response = await fetch(`${base}?since=${since}`);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-encoding"), "gzip");
            assert.deepEqual(
                await response.json(),
                await api.getTree({ query: { since } }, {}),
            );
        }
        const plain = await fetch(base, {
            headers: { "Accept-Encoding": "gzip;q=0" },
        });
        assert.equal(plain.headers.get("content-encoding"), null);
        await plain.arrayBuffer();
        authorized = false;
        const denied = await fetch(base);
        assert.equal(denied.status, 401);
        assert.deepEqual(await denied.json(), { error: "unauthorized" });
        authorized = true;
        await rm(db.shardPath(id, 1, 3));
        const broken = await fetch(base);
        await assert.rejects(broken.text());
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

test("large HTTP tree does not accumulate shard data on heap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-large-"));
    const db = await new Db(dir).open();
    const id = "b".repeat(32);
    const api = new CloudGramApi({ db, pepper: "x".repeat(40) });
    api.authenticate = async () => ({ user: { id } });
    const server = createApiServer(api, {
        log: { error() {} },
        diagLog: false,
    });
    try {
        const folder = join(dir, "trees", id);
        await mkdir(folder);
        await writeFile(
            join(folder, "0-1.json"),
            JSON.stringify({ iv: "a", ct: "b".repeat(1024 * 1024) }),
        );
        const shards = {};
        for (let n = 0; n < 300; n++) {
            shards[n] = 1;
            if (n)
                await link(
                    join(folder, "0-1.json"),
                    join(folder, `${n}-1.json`),
                );
        }
        await writeFile(
            join(folder, "meta.json"),
            JSON.stringify({ version: 1, count: 300, shards }),
        );
        await new Promise((resolve, reject) =>
            server.listen(0, "127.0.0.1", resolve).once("error", reject),
        );
        const before = process.memoryUsage().heapUsed;
        let peak = before;
        let total = 0;
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api/vault/tree`,
        );
        for await (const chunk of response.body) {
            total += chunk.length;
            peak = Math.max(peak, process.memoryUsage().heapUsed);
        }
        assert.ok(total > 300 * 1024 * 1024);
        assert.ok(
            peak - before < 100 * 1024 * 1024,
            `heap grew ${peak - before} bytes`,
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

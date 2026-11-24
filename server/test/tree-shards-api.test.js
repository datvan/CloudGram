import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudGramApi, LIMITS } from "../app.js";
import { Db } from "../db.js";

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

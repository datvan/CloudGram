import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { CloudGramApi, LIMITS } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";
import { Thumbs } from "../thumbs.js";

test("thumbnail API: isolation, limits, quota, deletion and backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-thumbs-"));
    const db = await new Db(dir).open();
    const api = new CloudGramApi({ db, pepper: "x".repeat(40) });
    const server = createApiServer(api, {
        log: { error() {} },
        diagLog: false,
    });
    const limits = { count: LIMITS.thumbsCount, bytes: LIMITS.thumbsBytes };
    try {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = async (path, body, method = "POST") => {
            const response = await fetch(base + path, {
                method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }).catch((error) => {
                throw new Error(`${path} ${JSON.stringify(body).length}`, {
                    cause: error,
                });
            });
            return [response.status, await response.json()];
        };
        const put = (thumbs) => call("/api/vault/thumbs", { thumbs }, "PUT");
        const get = (ids) => call("/api/vault/thumbs/get", { ids });
        const del = (ids) => call("/api/vault/thumbs/delete", { ids });
        const id = "a".repeat(16);
        const blob = {
            iv: "AQIDBA==",
            ct: Buffer.from([0, 1, 254, 255]).toString("base64"),
        };
        assert.equal((await put({ [id]: blob }))[0], 401);
        let userId = "a".repeat(32);
        api.authenticate = async () => ({ user: { id: userId } });
        assert.equal((await put({ [id]: blob }))[0], 200);
        assert.deepEqual((await get([id, "b".repeat(16)]))[1], {
            thumbs: { [id]: blob },
        });
        assert.ok((await stat(join(dir, "thumbs.sqlite-wal"))).size > 0);
        userId = "b".repeat(32);
        assert.deepEqual((await get([id]))[1], { thumbs: {} });
        await del([id]);
        userId = "a".repeat(32);
        assert.deepEqual((await get([id]))[1].thumbs[id], blob);
        for (const bad of [
            { x: blob },
            { [id]: { ...blob, ct: "%%%" } },
            { [id]: { ...blob, ct: "YQ" } },
            { [id]: { ...blob, ct: "Y".repeat(LIMITS.thumbCt + 4) } },
            Object.fromEntries(
                Array.from({ length: 65 }, (_, i) => [
                    String(i).padStart(16, "0"),
                    blob,
                ]),
            ),
        ])
            assert.equal((await put(bad))[0], 400);
        assert.equal((await get(Array(201).fill(id)))[0], 400);
        assert.equal((await del(Array(501).fill(id)))[0], 400);
        assert.equal((await get(["bad"]))[0], 400);
        LIMITS.thumbsCount = 1;
        assert.deepEqual(await put({ ["c".repeat(16)]: blob }), [
            413,
            { error: "thumbs_quota" },
        ]);
        LIMITS.thumbsCount = limits.count;
        LIMITS.thumbsBytes = 3;
        assert.equal((await put({ [id]: blob }))[0], 413);
        LIMITS.thumbsBytes = limits.bytes;
        const big = {
            iv: blob.iv,
            ct: Buffer.alloc(72 * 1024).toString("base64"),
        };
        const batch = Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [
                String(i).padStart(16, "0"),
                big,
            ]),
        );
        const ids = Object.keys(batch);
        assert.equal(
            (
                await put(
                    Object.fromEntries(Object.entries(batch).slice(0, 40)),
                )
            )[0],
            200,
        );
        assert.equal(
            (await put(Object.fromEntries(Object.entries(batch).slice(40))))[0],
            200,
        );
        const result = (await get(ids))[1];
        assert.equal(result.more, true);
        assert.ok(
            Buffer.byteLength(JSON.stringify(result)) <= LIMITS.thumbsBody,
        );
        assert.ok(Object.keys(result.thumbs).length < ids.length);
        const oversized = await fetch(base + "/api/vault/thumbs", {
            method: "PUT",
            headers: {
                "content-type": "application/json",
                connection: "close",
            },
            body: JSON.stringify({
                thumbs: {
                    [id]: {
                        ...blob,
                        ct: Buffer.alloc(LIMITS.thumbsBody).toString("base64"),
                    },
                },
            }),
        }).catch(() => null);
        if (oversized) assert.equal(oversized.status, 413);
        const backup = join(dir, "backup.sqlite");
        await api.thumbs.backup(backup);
        const { DatabaseSync } = await import("node:sqlite");
        const snapshot = new DatabaseSync(backup);
        assert.equal(
            snapshot.prepare("SELECT count(*) AS n FROM thumbs").get().n,
            51,
        );
        snapshot.close();
        db.data.users.alice = { id: userId, username: "alice" };
        await api.deleteUser("alice");
        assert.deepEqual((await get([id, ...ids]))[1], { thumbs: {} });
    } finally {
        LIMITS.thumbsCount = limits.count;
        LIMITS.thumbsBytes = limits.bytes;
        await new Promise((resolve) => server.close(resolve));
        if (api.thumbs.opening) (await api.thumbs.open()).close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("missing sqlite leaves other API routes working", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-thumbs-unavailable-"));
    const db = await new Db(dir).open();
    const api = new CloudGramApi({ db, pepper: "x".repeat(40) });
    api.thumbs = new Thumbs(dir, {
        load: async () => {
            throw new Error("missing");
        },
    });
    api.authenticate = async () => ({ user: { id: "a".repeat(32) } });
    const server = createApiServer(api, {
        log: { error() {} },
        diagLog: false,
    });
    try {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const response = await fetch(base + "/api/vault/thumbs/get", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: [] }),
        });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
            error: "thumbs_unavailable",
        });
        assert.equal((await fetch(base + "/api/vault/tree")).status, 200);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

test("account cleanup tolerates missing sqlite without creating a database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-thumbs-cleanup-"));
    try {
        const db = await new Db(dir).open();
        const api = new CloudGramApi({ db, pepper: "x".repeat(40) });
        let loads = 0;
        api.thumbs = new Thumbs(dir, {
            load: async () => {
                loads++;
                throw new Error("missing");
            },
        });
        await api.issueSetup("alice");
        await api.issueSetup("alice", { reset: true });
        assert.equal(loads, 0);
        await assert.rejects(stat(join(dir, "thumbs.sqlite")), {
            code: "ENOENT",
        });
        await writeFile(join(dir, "thumbs.sqlite"), "existing");
        await api.issueSetup("alice", { reset: true });
        await api.deleteUser("alice");
        assert.equal(db.data.users.alice, undefined);
        assert.equal(loads, 1);
        const failure = new Error("disk failure");
        await api.issueSetup("bob");
        api.thumbs.opening = Promise.reject(failure);
        await assert.rejects(
            api.issueSetup("bob", { reset: true }),
            (error) => error === failure,
        );
        await assert.rejects(
            api.deleteUser("bob"),
            (error) => error === failure,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("thumbnail handlers return unavailable without a database directory", async () => {
    const api = new CloudGramApi({ db: {}, pepper: "x".repeat(40) });
    api.authenticate = async () => ({ user: { id: "a" } });
    for (const [method, body] of [
        ["putThumbs", { thumbs: {} }],
        ["getThumbs", { ids: [] }],
        ["deleteThumbs", { ids: [] }],
    ])
        await assert.rejects(api[method]({ body }, {}), {
            status: 503,
            code: "thumbs_unavailable",
        });
});

test("oversized request stops before the client finishes sending", async () => {
    const api = new CloudGramApi({ db: {}, pepper: "x".repeat(40) });
    const server = createApiServer(api, {
        log: { error() {} },
        diagLog: false,
    });
    const limit = LIMITS.thumbsBody;
    LIMITS.thumbsBody = 32;
    try {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        await new Promise((resolve, reject) => {
            const socket = connect(server.address().port, "127.0.0.1", () => {
                socket.write(
                    "PUT /api/vault/thumbs HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n40\r\n" +
                        "x".repeat(64) +
                        "\r\n",
                );
            });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error("server kept reading"));
            }, 2000);
            socket.once("data", (data) => {
                clearTimeout(timer);
                socket.destroy();
                if (/HTTP\/1.1 413/.test(data.toString())) resolve();
                else reject(new Error(data.toString()));
            });
            socket.once("close", () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once("error", reject);
        });
    } finally {
        LIMITS.thumbsBody = limit;
        await new Promise((resolve) => server.close(resolve));
    }
});

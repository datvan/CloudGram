import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudGramApi } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";
import { Owners } from "../owners.js";
import { TelegramProxy } from "../tg-proxy.js";

test("authenticated Telegram proxy HTTP round trip and ownership", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgx-http-"));
    let server;
    try {
        const db = await new Db(dir).open();
        for (const name of ["alice", "bob"]) {
            db.data.users[name] = { id: name, username: name, verifier: {} };
            db.data.sessions[createHash("sha256").update(name).digest("hex")] =
                {
                    username: name,
                    expiresAt: Date.now() + 60000,
                };
        }
        const owners = await new Owners(dir).open();
        let bytes;
        let message;
        const telegram = {
            savePart: async (_upload, _index, part) => {
                bytes = part;
                return true;
            },
            send: async (_upload, body) =>
                (message = {
                    id: 7,
                    date: 1,
                    message: body.caption ?? "",
                    document: {
                        size: bytes.length,
                        mimeType: body.mime,
                        attributes: [
                            {
                                className: "DocumentAttributeFilename",
                                fileName: body.name,
                            },
                        ],
                        thumbs: [{ type: "a", w: 1, h: 1 }],
                    },
                }),
            getMessages: async (ids) =>
                ids.includes(7) && message ? [message] : [],
            getFile: async (_doc, offset, limit, thumb) =>
                thumb
                    ? Buffer.from("jpg")
                    : bytes.subarray(offset, offset + limit),
            deleteMessages: async () => {
                message = null;
            },
        };
        const tgx = new TelegramProxy({
            owners,
            telegram,
            limits: { callTimeout: 10 },
        });
        const api = new CloudGramApi({ db, pepper: "x".repeat(40), tgx });
        for (const name of ["alice", "bob"])
            api.leases.set(name, {
                holder: "browser",
                expires: Date.now() + 60000,
            });
        server = createApiServer(api, {
            origin: "https://cg.test",
            diagLog: true,
            log: { log() {} },
        });
        await new Promise((resolve, reject) =>
            server.listen(0, "127.0.0.1", resolve).on("error", reject),
        );
        const base = `http://127.0.0.1:${server.address().port}/api/tgx`;
        const call = (method, path, body, user = "alice", raw = false) =>
            fetch(base + path, {
                method,
                headers: {
                    Origin: "https://cg.test",
                    "X-CloudGram-Browser": "browser",
                    ...(user ? { Cookie: `cg_session=${user}` } : {}),
                    ...(method === "GET"
                        ? {}
                        : {
                              "Content-Type": raw
                                  ? "application/octet-stream"
                                  : "application/json",
                          }),
                },
                ...(method === "GET"
                    ? {}
                    : { body: raw ? body : JSON.stringify(body ?? {}) }),
            });
        const early = await new Promise((resolve, reject) => {
            const req = httpRequest(
                base + "/upload/x/0",
                {
                    method: "PUT",
                    headers: {
                        Origin: "https://cg.test",
                        "Content-Type": "application/octet-stream",
                        "Content-Length": "99999999",
                    },
                },
                (res) => {
                    res.resume();
                    resolve(res.statusCode);
                    req.destroy();
                },
            );
            req.on("error", reject);
            req.flushHeaders();
        });
        assert.equal(early, 401);
        const tooLarge = await new Promise((resolve, reject) => {
            const req = httpRequest(
                base + "/upload/x/0",
                {
                    method: "PUT",
                    headers: {
                        Origin: "https://cg.test",
                        "Content-Type": "application/octet-stream",
                        "Content-Length": String(8 * 524288 + 1),
                        Cookie: "cg_session=alice",
                        "X-CloudGram-Browser": "browser",
                    },
                },
                (res) => {
                    res.resume();
                    resolve(res.statusCode);
                    req.destroy();
                },
            );
            req.on("error", reject);
            req.flushHeaders();
        });
        assert.equal(tooLarge, 413);
        const batchUpload = await (
            await call("POST", "/upload/start", { size: 524288 + 3, parts: 2 })
        ).json();
        assert.equal(
            (
                await call(
                    "PUT",
                    `/upload/${batchUpload.uploadId}/0`,
                    Buffer.alloc(524289),
                    "alice",
                    true,
                )
            ).status,
            400,
        );
        assert.equal(
            (
                await call(
                    "PUT",
                    `/upload/${batchUpload.uploadId}/0`,
                    Buffer.alloc(524291),
                    "alice",
                    true,
                )
            ).status,
            200,
        );
        const lease = api.leases.get("alice");
        lease.expires = Date.now() + 10000;
        await call(
            "PUT",
            `/upload/${batchUpload.uploadId}/0`,
            Buffer.from("x"),
            "alice",
            true,
        );
        assert.ok(lease.expires > Date.now() + 25000);
        lease.expires = Date.now() + 10000;
        lease.pending = { browserId: "other", expires: Date.now() + 30000 };
        const beforePending = lease.expires;
        await call(
            "PUT",
            `/upload/${batchUpload.uploadId}/0`,
            Buffer.from("x"),
            "alice",
            true,
        );
        assert.equal(lease.expires, beforePending);
        delete lease.pending;
        lease.expires = Date.now() - 1;
        assert.equal(
            (await call("PUT", "/upload/x/0", Buffer.from("x"), "alice", true))
                .status,
            409,
        );
        assert.ok(lease.expires < Date.now());
        api.leases.delete("alice");
        for (const [method, path, body, raw] of [
            ["POST", "/upload/start", { size: 1, parts: 1 }],
            ["PUT", "/upload/x/0", Buffer.from("x"), true],
            ["POST", "/upload/x/finish", {}],
            ["POST", "/upload/x/cancel", {}],
            ["POST", "/delete", { ids: [] }],
        ])
            assert.equal(
                (await call(method, path, body, "alice", raw)).status,
                409,
            );
        assert.equal(
            (await call("POST", "/messages", { ids: [] })).status,
            200,
        );
        api.leases.set("alice", {
            holder: "other",
            expires: Date.now() + 60000,
        });
        const otherLease = { ...api.leases.get("alice") };
        assert.equal(
            (await call("POST", "/upload/start", { size: 1, parts: 1 })).status,
            409,
        );
        assert.deepEqual(api.leases.get("alice"), otherLease);
        api.leases.set("alice", {
            holder: "browser",
            expires: Date.now() + 60000,
        });
        assert.equal(
            (await call("POST", "/upload/start", { size: 5, parts: 1 }, null))
                .status,
            401,
        );
        for (const [method, path, body, raw] of [
            ["PUT", "/upload/x/0", Buffer.from("x"), true],
            ["POST", "/upload/x/finish", {}],
            ["POST", "/upload/x/cancel", {}],
            ["POST", "/messages", { ids: [] }],
            ["POST", "/delete", { ids: [] }],
            ["GET", "/file/7?offset=0&limit=1"],
            ["GET", "/thumb/7"],
        ])
            assert.equal(
                (await call(method, path, body, null, raw)).status,
                401,
            );
        const start = await (
            await call("POST", "/upload/start", {
                size: 5,
                parts: 1,
                username: "bob",
            })
        ).json();
        assert.equal(start.directKey, undefined);
        assert.equal(
            (
                await fetch(base.replace(/tgx$/, `tgxd/${start.uploadId}/0`), {
                    method: "PUT",
                    headers: {
                        Origin: "https://cg.test",
                        "Content-Type": "application/octet-stream",
                    },
                    body: "x",
                })
            ).status,
            404,
        );
        assert.equal(
            (
                await call(
                    "PUT",
                    `/upload/${start.uploadId}/0`,
                    Buffer.alloc(8 * 524288 + 1),
                    "alice",
                    true,
                )
            ).status,
            413,
        );
        assert.equal(
            (
                await call(
                    "PUT",
                    `/upload/${start.uploadId}/0`,
                    Buffer.from("hello"),
                    "alice",
                    true,
                )
            ).status,
            200,
        );
        const finish = await (
            await call("POST", `/upload/${start.uploadId}/finish`, {
                name: "x",
                mime: "text/plain",
            })
        ).json();
        assert.equal(finish.message.id, 7);
        assert.deepEqual(
            await (
                await call("POST", `/upload/${start.uploadId}/finish`, {})
            ).json(),
            finish,
        );
        assert.equal(
            (await call("POST", `/upload/${start.uploadId}/finish`, {}, "bob"))
                .status,
            404,
        );
        const getMessages = telegram.getMessages;
        telegram.getMessages = () => new Promise(() => {});
        const timeout = await call("POST", "/messages", { ids: [7] });
        assert.equal(timeout.status, 503);
        assert.deepEqual(await timeout.json(), { error: "telegram_busy" });
        telegram.getMessages = getMessages;
        assert.deepEqual(
            (
                await (
                    await call("POST", "/messages", { ids: [7] }, "bob")
                ).json()
            ).messages,
            [null],
        );
        assert.equal(
            (await call("GET", "/file/7?offset=0&limit=1", null, "bob")).status,
            404,
        );
        assert.equal((await call("GET", "/thumb/7", null, "bob")).status, 404);
        assert.deepEqual(
            await (await call("POST", "/delete", { ids: [7] }, "bob")).json(),
            { deleted: [] },
        );
        assert.equal(
            (await (await call("POST", "/messages", { ids: [7] })).json())
                .messages[0].id,
            7,
        );
        const file = await call("GET", "/file/7?offset=1&limit=3");
        assert.equal(
            file.headers.get("content-type"),
            "application/octet-stream",
        );
        assert.equal(file.headers.get("content-length"), "3");
        assert.equal(file.headers.get("cache-control"), "no-store");
        assert.equal(await file.text(), "ell");
        const thumb = await call("GET", "/thumb/7");
        assert.equal(thumb.headers.get("content-type"), "image/jpeg");
        assert.equal(await thumb.text(), "jpg");
        assert.deepEqual(
            await (await call("POST", "/delete", { ids: [7] })).json(),
            { deleted: [7] },
        );
        assert.deepEqual(
            (await (await call("POST", "/messages", { ids: [7] })).json())
                .messages,
            [null],
        );
        const second = await (
            await call("POST", "/upload/start", { size: 1, parts: 1 })
        ).json();
        await call(
            "PUT",
            `/upload/${second.uploadId}/0`,
            Buffer.from("x"),
            "alice",
            true,
        );
        owners.add = async () => {
            throw new Error("private ledger detail");
        };
        const logs = [];
        const originalLog = console.log;
        console.log = (line) => logs.push(line);
        try {
            const failed = await call(
                "POST",
                `/upload/${second.uploadId}/finish`,
                { name: "x", mime: "text/plain" },
            );
            assert.equal(failed.status, 500);
            assert.deepEqual(await failed.json(), { error: "internal" });
            assert.deepEqual(logs, ['{"src":"tgx","orphan":7}']);
        } finally {
            console.log = originalLog;
        }
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

test("direct upload keys retain lease, limits and revocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgxd-"));
    let server;
    try {
        const db = await new Db(dir).open();
        for (const name of ["alice", "bob"]) {
            db.data.users[name] = {
                id: name === "bob" ? "b".repeat(32) : name,
                username: name,
                verifier: {},
            };
            db.data.sessions[createHash("sha256").update(name).digest("hex")] =
                {
                    username: name,
                    expiresAt: Date.now() + 60000,
                };
        }
        const owners = await new Owners(dir).open();
        const telegram = {
            savePart: async () => true,
            send: async () => ({
                id: 7,
                date: 1,
                document: { size: 1, mimeType: "text/plain", attributes: [] },
            }),
        };
        const tgx = new TelegramProxy({ owners, telegram });
        const api = new CloudGramApi({
            db,
            pepper: "x".repeat(40),
            tgx,
            tgxDirect: true,
        });
        for (const name of ["alice", "bob"])
            api.leases.set(name, {
                holder: "browser",
                expires: Date.now() + 10000,
            });
        const logs = [];
        server = createApiServer(api, {
            origin: "https://cg.test",
            log: { log: (line) => logs.push(line) },
        });
        await new Promise((resolve, reject) =>
            server.listen(0, "127.0.0.1", resolve).on("error", reject),
        );
        const base = `http://127.0.0.1:${server.address().port}/api`;
        const call = (path, user = "alice", body = {}) =>
            fetch(base + path, {
                method: "POST",
                headers: {
                    Origin: "https://cg.test",
                    "Content-Type": "application/json",
                    Cookie: `cg_session=${user}`,
                    "X-CloudGram-Browser": "browser",
                },
                body: JSON.stringify(body),
            });
        const start = async (user = "alice") =>
            (
                await call("/tgx/upload/start", user, { size: 1, parts: 1 })
            ).json();
        const put = (id, key, extra = {}) =>
            fetch(`${base}/tgxd/${id}/0`, {
                method: "PUT",
                headers: {
                    Origin: "https://cg.test",
                    "Content-Type": "application/octet-stream",
                    "X-Upload-Key": key,
                    ...extra,
                },
                body: "x",
            });
        const a = await start();
        const b = await start("bob");
        assert.match(a.directKey, /^[A-Za-z0-9_-]{32}$/);
        const before = api.leases.get("alice").expires;
        assert.equal((await put(a.uploadId, a.directKey)).status, 200);
        assert.ok(api.leases.get("alice").expires > before);
        assert.equal(
            (await put(a.uploadId, a.directKey, { Origin: "https://bad.test" }))
                .status,
            403,
        );
        for (const [id, key] of [
            [a.uploadId, b.directKey],
            [b.uploadId, a.directKey],
            ["unknown", a.directKey],
        ]) {
            const response = await put(id, key);
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { error: "not_found" });
        }
        api.leases.get("alice").holder = "other";
        assert.equal((await put(a.uploadId, a.directKey)).status, 409);
        api.leases.get("alice").holder = "browser";
        tgx.rates.get("alice").part = 64;
        assert.equal((await put(a.uploadId, a.directKey)).status, 429);
        tgx.rates.get("alice").part = 0;
        assert.equal(
            (
                await call(`/tgx/upload/${a.uploadId}/finish`, "alice", {
                    name: "x",
                    mime: "text/plain",
                })
            ).status,
            200,
        );
        assert.equal((await put(a.uploadId, a.directKey)).status, 404);
        assert.equal(
            (await call(`/tgx/upload/${b.uploadId}/cancel`, "bob")).status,
            200,
        );
        assert.equal((await put(b.uploadId, b.directKey)).status, 404);
        const c = await start();
        assert.equal(
            (await call("/auth/logout", "alice", { browserId: "browser" }))
                .status,
            200,
        );
        assert.equal((await put(c.uploadId, c.directKey)).status, 404);
        const d = await start("bob");
        tgx.uploads.get(d.uploadId).created -= tgx.limits.ttl;
        assert.equal((await put(d.uploadId, d.directKey)).status, 404);
        const e = await start("bob");
        await api.issueSetup("bob", { reset: true });
        assert.equal((await put(e.uploadId, e.directKey)).status, 404);
        const f = await tgx.startUpload(
            db.data.users.bob.id,
            { size: 1, parts: 1 },
            { username: "bob", browserId: "browser" },
        );
        await api.deleteUser("bob");
        assert.equal((await put(f.uploadId, f.directKey)).status, 404);
        assert.ok(
            logs.every(
                (line) =>
                    ![
                        a.directKey,
                        b.directKey,
                        c.directKey,
                        d.directKey,
                        e.directKey,
                        f.directKey,
                    ].some((key) => line.includes(key)),
            ),
        );
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

test("reset preserves ownership and deleting then recreating username drops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgx-account-"));
    try {
        const db = await new Db(dir).open();
        const owners = await new Owners(dir).open();
        const api = new CloudGramApi({ db, owners, pepper: "x".repeat(40) });
        await api.issueSetup("alice");
        const oldId = db.data.users.alice.id;
        await owners.add(oldId, 7);
        await api.issueSetup("alice", { reset: true });
        assert.equal(owners.owns(oldId, 7), true);
        await api.deleteUser("alice");
        await api.issueSetup("alice");
        const newId = db.data.users.alice.id;
        assert.notEqual(newId, oldId);
        assert.equal(owners.owns(newId, 7), false);
        assert.equal((await new Owners(dir).open()).owns(newId, 7), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

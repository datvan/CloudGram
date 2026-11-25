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
        const tgx = new TelegramProxy({ owners, telegram });
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
        assert.equal(
            (await call("POST", "/upload/start", { size: 1, parts: 1 })).status,
            409,
        );
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
        assert.equal(
            (
                await call(
                    "PUT",
                    `/upload/${start.uploadId}/0`,
                    Buffer.alloc(524289),
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

test("reset preserves ownership and deleting then recreating username drops it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tgx-account-"));
    try {
        const db = await new Db(dir).open();
        const owners = await new Owners(dir).open(db.data.users);
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
        assert.equal(
            (await new Owners(dir).open(db.data.users)).owns(newId, 7),
            false,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

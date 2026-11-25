import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudGramApi } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";
import { SharedTelegram } from "../shared-telegram.js";

test("encrypted root and authenticated approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-tg-"));
    let server;
    try {
        const root = new SharedTelegram(dir, {
            CLOUDGRAM_TG_ROOT_KEY: randomBytes(32).toString("base64"),
        });
        await root.save("secret-session");
        assert.equal(await root.load(), "secret-session");
        assert.equal(
            (await readFile(root.file, "utf8")).includes("secret-session"),
            false,
        );
        const db = await new Db(dir).open();
        const cookie = "test-cookie";
        db.data.users.alice = { username: "alice", verifier: {} };
        db.data.sessions[createHash("sha256").update(cookie).digest("hex")] = {
            username: "alice",
            expiresAt: Date.now() + 60000,
        };
        let linked = true;
        let received;
        const shared = {
            approve: async (token) => {
                received = token;
                return linked;
            },
        };
        const api = new CloudGramApi({
            db,
            pepper: "x".repeat(40),
            admins: ["alice"],
            sharedTelegram: shared,
        });
        server = createApiServer(api, {
            origin: "https://cg.test",
            diagLog: false,
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${server.address().port}/api/tg/approve`;
        const call = (headers = {}) =>
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...headers },
                body: JSON.stringify({ token: "dG9rZW4=" }),
            });
        assert.equal((await call()).status, 401);
        assert.equal(
            (
                await call({
                    Cookie: `cg_session=${cookie}`,
                    Origin: "https://evil.test",
                })
            ).status,
            403,
        );
        const auth = { Cookie: `cg_session=${cookie}` };
        assert.equal((await call(auth)).status, 200);
        assert.equal(received.toString(), "token");
        linked = false;
        const missing = await call(auth);
        assert.equal(missing.status, 503);
        assert.equal((await missing.json()).error, "telegram_not_linked");
        for (let i = 0; i < 3; i++) await call(auth);
        assert.equal((await call(auth)).status, 429);
        shared.enabled = false;
        assert.equal((await call()).status, 404);
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

test("session issuance authenticates, limits, maps errors and never logs session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-tg-session-"));
    let server;
    try {
        const db = await new Db(dir).open();
        const cookie = "session-cookie";
        db.data.users.alice = { username: "alice", verifier: {} };
        db.data.sessions[createHash("sha256").update(cookie).digest("hex")] = {
            username: "alice",
            expiresAt: Date.now() + 3600000,
        };
        let now = Date.now();
        let failure;
        let calls = 0;
        const shared = {
            issue: async () => {
                calls++;
                if (failure)
                    throw Object.assign(new Error("sensitive details"), {
                        code: failure,
                    });
                return { session: "secret-issued-session", dcId: 2 };
            },
            approve: async () => true,
        };
        const api = new CloudGramApi({
            db,
            pepper: "x".repeat(40),
            admins: ["alice"],
            sharedTelegram: shared,
            now: () => now,
        });
        const logs = [];
        server = createApiServer(api, {
            origin: "https://cg.test",
            log: { log: (line) => logs.push(line) },
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = (path, authenticated = true, body = {}) =>
            fetch(`${base}/api/tg/${path}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(authenticated
                        ? { Cookie: `cg_session=${cookie}` }
                        : {}),
                },
                body: JSON.stringify(body),
            });
        shared.enabled = false;
        let response = await call("session", false);
        assert.equal(response.status, 404);
        assert.equal((await response.json()).error, "not_found");
        shared.enabled = true;
        assert.equal((await call("session", false)).status, 401);
        response = await fetch(`${base}/api/tg/session`, {
            method: "POST",
            headers: {
                Cookie: "cg_session=invalid",
                "Content-Type": "application/json",
            },
            body: "{}",
        });
        assert.equal(response.status, 401);
        assert.equal(calls, 0);
        response = await call("session");
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
            session: "secret-issued-session",
            dcId: 2,
        });
        for (const code of [
            "telegram_not_linked",
            "telegram_password_missing",
            "telegram_password_invalid",
            "telegram_busy",
        ]) {
            failure = code;
            response = await call("session");
            assert.equal(response.status, 503);
            assert.equal((await response.json()).error, code);
        }
        assert.equal((await call("session")).status, 429);
        now += 600001;
        failure = "unexpected";
        response = await call("session");
        assert.equal(response.status, 500);
        assert.equal((await response.json()).error, "internal");
        failure = null;
        assert.equal(
            (await call("approve", true, { token: "dG9rZW4=" })).status,
            200,
        );
        for (let i = 0; i < 3; i++)
            assert.equal((await call("session")).status, 200);
        assert.equal(
            (await call("approve", true, { token: "dG9rZW4=" })).status,
            429,
        );
        assert.ok(logs.some((line) => line.includes("issueTelegramSession")));
        assert.equal(logs.join("\n").includes("secret-issued-session"), false);
        assert.equal(logs.join("\n").includes("sensitive details"), false);
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

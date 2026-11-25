import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CloudGramApi } from "../app.js";
import { createApiServer } from "../http.js";

test("admin controls Telegram sessions and quick login over HTTP", async () => {
    const db = {
        data: { users: {}, sessions: {}, shares: {} },
        save: async () => {},
    };
    const key = "a".repeat(64);
    const proof = Buffer.alloc(32, 7).toString("base64url");
    const blob = { iv: "AAAA", ct: "BBBB" };
    const api = new CloudGramApi({
        db,
        pepper: "x".repeat(40),
        admins: [" ALICE "],
        sharedTelegram: {
            issue: async () => ({ session: "telegram" }),
            approve: async () => true,
        },
    });
    const server = createApiServer(api, { diagLog: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body, cookie) => {
        const response = await fetch(base + path, {
            method,
            headers: {
                ...(method !== "GET"
                    ? { "Content-Type": "application/json" }
                    : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
        });
        return {
            status: response.status,
            body: await response.json(),
            cookie: response.headers.getSetCookie()[0]?.split(";")[0],
        };
    };
    try {
        const cookies = {};
        for (const name of ["alice", "bob"]) {
            const token = await api.issueSetup(name);
            const setup = await call("POST", "/api/auth/setup", {
                token,
                kdf: { salt: "AAAA", iterations: 600000 },
                loginKey: key,
                wrappedDek: blob,
            });
            assert.equal(setup.body.admin, name === "alice");
            cookies[name] = setup.cookie;
            assert.equal(
                (await call("GET", "/api/me", null, setup.cookie)).body.admin,
                name === "alice",
            );
        }
        const routes = [
            ["POST", "/api/tg/session", {}],
            ["POST", "/api/tg/approve", { token: "dG9rZW4=" }],
            [
                "POST",
                "/api/quick/enable",
                { loginKey: key, proof, wrappedDek: blob },
            ],
            [
                "PUT",
                "/api/vault/session",
                { browserId: "aaaaaaaaaaaaaaaaaaaa", session: blob },
            ],
            ["GET", "/api/vault/session", null],
        ];
        await call(
            "POST",
            "/api/lease",
            { browserId: "aaaaaaaaaaaaaaaaaaaa" },
            cookies.alice,
        );
        for (const [method, path, body] of routes) {
            const denied = await call(method, path, body, cookies.bob);
            assert.equal(denied.status, 403, path);
            assert.equal(denied.body.error, "admin_only", path);
            assert.equal(
                (await call(method, path, body, cookies.alice)).status,
                200,
                path,
            );
        }
        const good = await call("POST", "/api/auth/quick-login", {
            username: "alice",
            proof,
        });
        assert.equal(good.status, 200);
        // Simulate quick credentials created before admin access was removed.
        db.data.users.bob.quick = db.data.users.alice.quick;
        const denied = await call("POST", "/api/auth/quick-login", {
            username: "bob",
            proof,
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.body.error, "admin_only");
        const unknown = await call("POST", "/api/auth/quick-login", {
            username: "nobody",
            proof,
        });
        assert.equal(unknown.status, 401);
        assert.equal(unknown.body.error, "bad_credentials");
        assert.equal(
            (await call("DELETE", "/api/vault/session", {}, cookies.bob))
                .status,
            200,
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("admin environment parsing and explicit override", async () => {
    const previous = process.env.CLOUDGRAM_ADMINS;
    const db = {
        data: { users: {}, sessions: {}, shares: {} },
        save: async () => {},
    };
    const token = "cookie";
    db.data.users.alice = { username: "alice", verifier: {} };
    db.data.sessions[createHash("sha256").update(token).digest("hex")] = {
        username: "alice",
        expiresAt: Date.now() + 60000,
    };
    const req = { cookies: { cg_session: token } };
    try {
        for (const [value, admins, expected] of [
            [" Bob, ALICE , ", undefined, true],
            ["", undefined, false],
            ["alice", [], false],
        ]) {
            process.env.CLOUDGRAM_ADMINS = value;
            const api = new CloudGramApi({
                db,
                pepper: "x".repeat(40),
                ...(admins ? { admins } : {}),
            });
            assert.equal((await api.me(req, {})).admin, expected);
        }
        delete process.env.CLOUDGRAM_ADMINS;
        assert.equal(
            (await new CloudGramApi({ db, pepper: "x".repeat(40) }).me(req, {}))
                .admin,
            false,
        );
    } finally {
        if (previous === undefined) delete process.env.CLOUDGRAM_ADMINS;
        else process.env.CLOUDGRAM_ADMINS = previous;
    }
});

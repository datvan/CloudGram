/**
 * End-to-end over real HTTP, using the browser's crypto module, so a mismatch
 * between what the client sends and what the server checks shows up here.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CloudGramApi } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";
import * as vault from "../../src/services/crypto.js";

let dir, api, server, base;
const fast = { iterations: 600_000 };

before(async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-api-"));
    const db = await new Db(dir).open();
    api = new CloudGramApi({ db, pepper: "x".repeat(40) });
    server = createApiServer(api, {
        origin: "https://cg.test",
        secureCookies: false,
        log: { error() {} },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
});

function client() {
    let cookie = "";
    return async (method, path, body, headers = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                ...(body ? { "Content-Type": "application/json" } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.getSetCookie();
        if (set.length) cookie = set[0].split(";")[0];
        if (cookie.endsWith("=")) cookie = "";
        return { status: res.status, body: await res.json() };
    };
}

async function setup(call, username, password) {
    const token = await api.issueSetup(username);
    const info = await call("POST", "/api/auth/setup-info", { token });
    assert.equal(info.body.username, username);
    const kdf = { ...vault.newKdf(), ...fast };
    const { loginKey, kek } = await vault.deriveKeys(password, kdf);
    const { dek, wrappedDek } = await vault.createDek(kek);
    const done = await call("POST", "/api/auth/setup", {
        token,
        kdf,
        loginKey,
        wrappedDek,
        remember: true,
    });
    assert.equal(done.status, 200);
    return { dek, token };
}

async function login(call, username, password) {
    const pre = await call("POST", "/api/auth/prelogin", { username });
    const { loginKey, kek } = await vault.deriveKeys(password, pre.body.kdf);
    const res = await call("POST", "/api/auth/login", {
        username,
        loginKey,
        remember: true,
    });
    if (res.status !== 200) return { res };
    return { res, dek: await vault.unwrapDek(kek, res.body.wrappedDek) };
}

test("setup, login on a second device, and both read the same vault", async () => {
    const a = client();
    const { dek, token } = await setup(a, "alice", "correct horse");

    // the token is single use
    const again = await a("POST", "/api/auth/setup-info", { token });
    assert.equal(again.status, 404);

    const browserA = "aaaaaaaaaaaaaaaaaaaa";
    assert.equal(
        (await a("POST", "/api/lease", { browserId: browserA })).body.status,
        "granted",
    );
    const session = await vault.encryptJson(
        dek,
        { session: "1abc" },
        "telegram-session",
    );
    assert.equal(
        (await a("PUT", "/api/vault/session", { session, browserId: browserA }))
            .status,
        200,
    );

    const tree = await vault.encryptJson(
        dek,
        { records: [{ id: "1", name: "x" }] },
        "file-tree",
    );
    assert.equal(
        (await a("PUT", "/api/vault/tree", { tree, baseVersion: 0 })).body
            .version,
        1,
    );
    const stale = await a("PUT", "/api/vault/tree", { tree, baseVersion: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.version, 1);

    const b = client();
    const { res, dek: dekB } = await login(b, "alice", "correct horse");
    assert.equal(res.body.hasTelegram, true);
    const got = await b("GET", "/api/vault/session");
    assert.deepEqual(
        await vault.decryptJson(dekB, got.body.session, "telegram-session"),
        { session: "1abc" },
    );
    const gotTree = await b("GET", "/api/vault/tree");
    assert.equal(
        (await vault.decryptJson(dekB, gotTree.body, "file-tree")).records[0]
            .name,
        "x",
    );

    // a blob cannot be read under the other label
    await assert.rejects(
        vault.decryptJson(dekB, got.body.session, "file-tree"),
    );
});

test("wrong password and unknown users look the same", async () => {
    const c = client();
    const known = await c("POST", "/api/auth/prelogin", { username: "alice" });
    const unknown1 = await c("POST", "/api/auth/prelogin", {
        username: "nobody",
    });
    const unknown2 = await c("POST", "/api/auth/prelogin", {
        username: "nobody",
    });
    assert.deepEqual(unknown1.body, unknown2.body);
    assert.notEqual(known.body.kdf.salt, unknown1.body.kdf.salt);

    const bad = await login(c, "alice", "wrong");
    assert.equal(bad.res.status, 401);
    const none = await login(c, "nobody", "whatever");
    assert.equal(none.res.status, 401);
    assert.equal(bad.res.body.error, none.res.body.error);
    assert.equal((await c("GET", "/api/me")).status, 401);
});

test("lease takeover waits for the holder to let go", async () => {
    const a = client();
    await login(a, "alice", "correct horse");
    const b = client();
    await login(b, "alice", "correct horse");
    const A = "holder-aaaaaaaaaaaaaaaa";
    const B = "taker-bbbbbbbbbbbbbbbbbb";

    // the first test left a lease with another browser id; let it go
    api.leases.clear();
    assert.equal(
        (await a("POST", "/api/lease", { browserId: A })).body.status,
        "granted",
    );
    assert.equal(
        (await b("POST", "/api/lease", { browserId: B })).body.status,
        "busy",
    );
    assert.equal(
        (await b("POST", "/api/lease", { browserId: B, takeover: true })).body
            .status,
        "waiting",
    );
    // B still has to wait while A has not heard about it
    assert.equal(
        (await b("POST", "/api/lease", { browserId: B })).body.status,
        "waiting",
    );
    assert.equal(
        (await a("POST", "/api/lease", { browserId: A })).body.status,
        "revoked",
    );
    // only B may write the session now? not yet, A has not released
    assert.equal(
        (
            await b("PUT", "/api/vault/session", {
                browserId: B,
                session: { iv: "AA==", ct: "AA==" },
            })
        ).status,
        409,
    );
    await a("POST", "/api/lease/release", { browserId: A });
    assert.equal(
        (await b("POST", "/api/lease", { browserId: B })).body.status,
        "granted",
    );
    assert.equal(
        (await a("POST", "/api/lease", { browserId: A })).body.status,
        "busy",
    );
});

test("password change re-wraps the DEK and signs other devices out", async () => {
    const a = client();
    const { dek } = await login(a, "alice", "correct horse");
    const other = client();
    await login(other, "alice", "correct horse");

    const pre = await a("POST", "/api/auth/prelogin", { username: "alice" });
    const oldKeys = await vault.deriveKeys("correct horse", pre.body.kdf);
    const me = await a("GET", "/api/me");
    const kdf = { ...vault.newKdf(), ...fast };
    const newKeys = await vault.deriveKeys("battery staple", kdf);
    const wrappedDek = await vault.rewrapDek(
        oldKeys.kek,
        me.body.wrappedDek,
        newKeys.kek,
    );
    const res = await a("POST", "/api/auth/password", {
        loginKey: oldKeys.loginKey,
        newLoginKey: newKeys.loginKey,
        kdf,
        wrappedDek,
    });
    assert.equal(res.status, 200);
    assert.equal((await other("GET", "/api/me")).status, 401);
    assert.equal((await a("GET", "/api/me")).status, 200);

    const fresh = client();
    const { dek: dek2 } = await login(fresh, "alice", "battery staple");
    // same DEK, so the existing blobs still open
    const blob = await vault.encryptJson(dek, { ok: 1 }, "t");
    assert.deepEqual(await vault.decryptJson(dek2, blob, "t"), { ok: 1 });
});

test("writes need JSON and the right origin; logout clears the session", async () => {
    const a = client();
    await login(a, "alice", "battery staple");
    const form = await fetch(`${base}/api/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "x=1",
    });
    assert.equal(form.status, 415);
    const evil = await a(
        "POST",
        "/api/auth/logout",
        {},
        { Origin: "https://evil.test" },
    );
    assert.equal(evil.status, 403);
    assert.equal((await a("POST", "/api/auth/logout", {})).status, 200);
    assert.equal((await a("GET", "/api/me")).status, 401);
    assert.equal((await a("GET", "/api/nope")).status, 404);
});

test("login is rate limited per IP", async () => {
    const c = client();
    let last;
    for (let i = 0; i < 12; i += 1) {
        last = await c(
            "POST",
            "/api/auth/login",
            { username: "mallory", loginKey: "0".repeat(64) },
            { "CF-Connecting-IP": "203.0.113.9" },
        );
    }
    assert.equal(last.status, 429);
});

/**
 * Share links end to end: encrypt in "the browser", upload in chunks, read it
 * back anonymously, then expire and revoke.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CloudGramApi } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";
import { SHARE_CHUNK } from "../shares.js";
import * as vault from "../../src/services/crypto.js";
import * as sc from "../../src/services/shareCrypto.js";

const ORIGIN = "https://cg.test";
const DAY = 24 * 60 * 60 * 1000;
let dir, api, server, base;
let clock = Date.now();

before(async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-shares-"));
    const db = await new Db(dir).open();
    api = new CloudGramApi({
        db,
        pepper: "x".repeat(40),
        now: () => clock,
        shareQuota: 3 * SHARE_CHUNK,
    });
    server = createApiServer(api, {
        origin: ORIGIN,
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

let cookie = "";
async function call(method, path, body) {
    const res = await fetch(base + path, {
        method,
        headers: {
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            Origin: ORIGIN,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set[0].split(";")[0];
    return { status: res.status, body: await res.json() };
}

function putChunk(id, index, bytes, headers = {}) {
    return fetch(`${base}/api/shares/${id}/chunks/${index}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/octet-stream",
            Cookie: cookie,
            Origin: ORIGIN,
            ...headers,
        },
        body: bytes,
    });
}

async function signUp() {
    const token = await api.issueSetup("sharer");
    const kdf = { ...vault.newKdf(), iterations: 600_000 };
    const { loginKey, kek } = await vault.deriveKeys("long password!", kdf);
    const { wrappedDek } = await vault.createDek(kek);
    const res = await call("POST", "/api/auth/setup", {
        token,
        kdf,
        loginKey,
        wrappedDek,
        remember: true,
    });
    assert.equal(res.status, 200);
}

// the clock jumps further than a login lasts
async function signIn() {
    const pre = await call("POST", "/api/auth/prelogin", {
        username: "sharer",
    });
    const { loginKey } = await vault.deriveKeys("long password!", pre.body.kdf);
    const res = await call("POST", "/api/auth/login", {
        username: "sharer",
        loginKey,
        remember: true,
    });
    assert.equal(res.status, 200);
}

/** Share `plain` the way the browser does; returns id and secret. */
async function share(plain, days) {
    const { key, secret } = await sc.newShareKey();
    const meta = await sc.encryptMeta(key, {
        name: "a.bin",
        mime: "application/octet-stream",
        size: plain.length,
    });
    const created = await call("POST", "/api/shares", {
        bytes: plain.length,
        days,
        meta,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { id, chunks, chunkSize } = created.body;
    for (let i = 0; i < chunks; i += 1) {
        const part = plain.subarray(i * chunkSize, (i + 1) * chunkSize);
        const res = await putChunk(id, i, await sc.encryptChunk(key, i, part));
        assert.equal(res.status, 200);
    }
    return { id, secret, chunks };
}

/** Read a share the way the public page does, with no cookie. */
async function fetchShare(id, secret) {
    const res = await fetch(`${base}/api/s/${id}`);
    if (res.status !== 200) return { status: res.status };
    const info = await res.json();
    const key = await sc.importShareKey(secret);
    const meta = await sc.decryptMeta(key, info.meta);
    const parts = [];
    for (let i = 0; i < info.chunks; i += 1) {
        const chunk = await fetch(`${base}/api/s/${id}/${i}`);
        const bytes = new Uint8Array(await chunk.arrayBuffer());
        parts.push(await sc.decryptChunk(key, i, bytes));
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return { status: 200, meta, bytes: out, info };
}

test("a shared file round-trips through chunks, then expires", async () => {
    await signUp();
    const plain = new Uint8Array(SHARE_CHUNK + 1000).map((_, i) => i % 253);
    const { id, secret, chunks } = await share(plain, 7);
    assert.equal(chunks, 2);

    // not visible until every chunk is in and it is marked complete
    assert.equal((await fetch(`${base}/api/s/${id}`)).status, 404);
    const done = await call("POST", `/api/shares/${id}/complete`, {});
    assert.equal(done.status, 200);

    const got = await fetchShare(id, secret);
    assert.equal(got.meta.name, "a.bin");
    assert.equal(got.meta.size, plain.length);
    assert.deepEqual(got.bytes, plain);
    assert.equal(got.info.expiresAt, clock + 7 * DAY);

    // a chunk served under another index does not decrypt
    const key = await sc.importShareKey(secret);
    const first = new Uint8Array(
        await (await fetch(`${base}/api/s/${id}/0`)).arrayBuffer(),
    );
    await assert.rejects(sc.decryptChunk(key, 1, first));

    // expiry hides it at once and the sweep deletes the bytes
    clock += 7 * DAY + 1;
    assert.equal((await fetchShare(id, secret)).status, 404);
    await api.sweep();
    assert.deepEqual(await readdir(join(dir, "shares")), []);
    await signIn();
    assert.equal((await call("GET", "/api/shares")).body.shares.length, 0);
});

test("forever links stay; revoking deletes them", async () => {
    const plain = new Uint8Array(500).fill(7);
    const { id, secret } = await share(plain, null);
    await call("POST", `/api/shares/${id}/complete`, {});
    clock += 3000 * DAY;
    await api.sweep();
    const got = await fetchShare(id, secret);
    assert.equal(got.info.expiresAt, null);
    assert.deepEqual(got.bytes, plain);

    await signIn();
    const list = await call("GET", "/api/shares");
    assert.equal(list.body.shares[0].id, id);

    assert.equal((await call("DELETE", `/api/shares/${id}`, {})).status, 200);
    assert.equal((await fetch(`${base}/api/s/${id}`)).status, 404);
    assert.deepEqual(await readdir(join(dir, "shares")), []);
});

test("uploads need the owner, the origin, bytes and quota", async () => {
    const plain = new Uint8Array(100);
    const { key } = await sc.newShareKey();
    const meta = await sc.encryptMeta(key, { name: "x", size: 100 });
    const { body } = await call("POST", "/api/shares", {
        bytes: 100,
        days: 1,
        meta,
    });
    const chunk = await sc.encryptChunk(key, 0, plain);

    assert.equal(
        (await putChunk(body.id, 0, chunk, { Origin: "https://evil.test" }))
            .status,
        403,
    );
    assert.equal(
        (await putChunk(body.id, 0, chunk, { "Content-Type": "text/plain" }))
            .status,
        415,
    );
    assert.equal((await putChunk(body.id, 5, chunk)).status, 400);
    assert.equal(
        (await putChunk(body.id, 0, chunk, { Cookie: "" })).status,
        401,
    );

    const missing = await call("POST", `/api/shares/${body.id}/complete`, {});
    assert.equal(missing.body.error, "chunk_missing");

    const over = await call("POST", "/api/shares", {
        bytes: 3 * SHARE_CHUNK,
        days: 1,
        meta,
    });
    assert.equal(over.body.error, "share_quota");
    const badDays = await call("POST", "/api/shares", {
        bytes: 1,
        days: 0,
        meta,
    });
    assert.equal(badDays.body.error, "bad_expiry");

    // unfinished uploads are swept after a day
    clock += DAY + 1;
    await api.sweep();
    await signIn();
    assert.equal((await call("GET", "/api/shares")).body.shares.length, 0);
});

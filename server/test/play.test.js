/**
 * Playing a video in an outside player: the player reads a Range address here
 * (no cookie), the tab (played by tab() below) answers the chunks it is asked
 * for, and the server keeps them in a bounded cache.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CloudGramApi } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";
import { PLAY_CHUNK } from "../play.js";
import * as vault from "../../src/services/crypto.js";

const ORIGIN = "https://cg.test";
const C = PLAY_CHUNK;
// 6 chunks, the last one short
const VIDEO = Buffer.alloc(5 * C + 12345);
for (let i = 0; i < VIDEO.length; i++) VIDEO[i] = (i * 7 + (i >> 9)) & 255;

let dir, api, server, base, cookie;
let clock = Date.now();

before(async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-play-"));
    api = new CloudGramApi({
        db: await new Db(dir).open(),
        pepper: "x".repeat(40),
        now: () => clock,
        play: {
            limits: {
                pollMs: 300,
                waitMs: 2000,
                ahead: 2,
                sessionBytes: 4 * C,
            },
        },
    });
    await api.play.reset();
    server = createApiServer(api, {
        origin: ORIGIN,
        secureCookies: false,
        log: { error() {} },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const token = await api.issueSetup("viewer");
    const kdf = { ...vault.newKdf(), iterations: 600_000 };
    const { loginKey, kek } = await vault.deriveKeys("long password!", kdf);
    const { wrappedDek } = await vault.createDek(kek);
    const res = await fetch(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
            token,
            kdf,
            loginKey,
            wrappedDek,
            remember: true,
        }),
    });
    assert.equal(res.status, 200);
    cookie = res.headers.getSetCookie()[0].split(";")[0];
});

after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
});

/** The tab's calls: with the cookie and the page's Origin. */
function page(method, path, body) {
    // the server takes only JSON on writes, a bodiless DELETE included
    if (method !== "GET") body ??= {};
    return fetch(base + path, {
        method,
        headers: {
            ...(body ? { "Content-Type": "application/json" } : {}),
            Cookie: cookie,
            Origin: ORIGIN,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
}

async function create(over = {}) {
    const res = await page("POST", "/api/play", {
        name: "clip.ts",
        size: VIDEO.length,
        type: "video/mp2t",
        ...over,
    });
    return { status: res.status, ...(await res.json()) };
}

/** What the tab does: polls, reads the chunk, puts it. */
function tab(id, { fail = false } = {}) {
    let stop = false;
    const asked = [];
    const loop = async () => {
        while (!stop) {
            const res = await page("GET", `/api/play/${id}/next`);
            if (res.status !== 200) return;
            const { index } = await res.json();
            if (index === null) continue;
            asked.push(index);
            if (fail) {
                await page("POST", `/api/play/${id}/fail`, { index });
                continue;
            }
            await fetch(`${base}/api/play/${id}/chunks/${index}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/octet-stream",
                    Cookie: cookie,
                    Origin: ORIGIN,
                },
                body: VIDEO.subarray(index * C, (index + 1) * C),
            });
        }
    };
    const done = Promise.all([loop(), loop(), loop()]);
    return {
        asked,
        stop: async () => {
            stop = true;
            await page("DELETE", `/api/play/${id}`);
            await done;
        },
    };
}

/** The player's call: no cookie, no Origin. */
const get = async (path, range) => {
    const res = await fetch(base + path, {
        headers: range ? { Range: range } : {},
    });
    return {
        status: res.status,
        headers: res.headers,
        body: Buffer.from(await res.arrayBuffer()),
    };
};

test("opening a video needs a signed-in tab", async () => {
    const res = await fetch(`${base}/api/play`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({ name: "a.ts", size: 10 }),
    });
    assert.equal(res.status, 401);
    assert.equal((await create({ size: -1 })).status, 400);
    assert.equal((await create({ size: 1.5 })).status, 400);
});

test("the player reads with Range, the tab supplies the bytes", async () => {
    const made = await create({ name: "my clip?.ts" });
    assert.equal(made.status, 200);
    assert.match(made.id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(made.path, `/api/p/${made.id}/my%20clip_.ts`);
    const fake = tab(made.id);

    const whole = await get(made.path);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-length"), String(VIDEO.length));
    assert.equal(whole.headers.get("content-type"), "video/mp2t");
    assert.equal(whole.headers.get("x-accel-buffering"), "no");
    assert.ok(whole.body.equals(VIDEO));

    // across a chunk edge, then an open end, then the tail an mp4 index hides in
    const edge = await get(made.path, `bytes=${C - 10}-${C + 9}`);
    assert.equal(edge.status, 206);
    assert.equal(
        edge.headers.get("content-range"),
        `bytes ${C - 10}-${C + 9}/${VIDEO.length}`,
    );
    assert.ok(edge.body.equals(VIDEO.subarray(C - 10, C + 10)));
    const rest = await get(made.path, `bytes=${5 * C}-`);
    assert.ok(rest.body.equals(VIDEO.subarray(5 * C)));
    const tail = await get(made.path, "bytes=-100");
    assert.ok(tail.body.equals(VIDEO.subarray(VIDEO.length - 100)));
    assert.equal((await get(made.path, `bytes=${VIDEO.length}-`)).status, 416);

    const head = await fetch(base + made.path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("accept-ranges"), "bytes");

    // never asked for a chunk the video does not have
    assert.ok(fake.asked.every((i) => i >= 0 && i < made.chunks));
    await fake.stop();
});

test("chunks are read ahead of the player", async () => {
    const made = await create();
    const fake = tab(made.id);
    // the first chunk only; the cache then holds the two after it as well
    const first = await get(made.path, "bytes=0-9");
    assert.ok(first.body.equals(VIDEO.subarray(0, 10)));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(fake.asked.includes(1) && fake.asked.includes(2));
    assert.ok(!fake.asked.includes(5));
    await fake.stop();
});

test("a wrong token, name or chunk gets nothing", async () => {
    const made = await create();
    assert.equal((await get(`/api/p/${"A".repeat(22)}/x.ts`)).status, 404);
    assert.equal((await get(`/api/p/short/x.ts`)).status, 404);
    // the tab's routes need its cookie
    const bare = await fetch(`${base}/api/play/${made.id}/next`);
    assert.equal(bare.status, 401);
    // a chunk of the wrong length is refused, not cached
    const bad = await fetch(`${base}/api/play/${made.id}/chunks/0`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/octet-stream",
            Cookie: cookie,
            Origin: ORIGIN,
        },
        body: Buffer.alloc(100),
    });
    assert.equal(bad.status, 400);
    await page("DELETE", `/api/play/${made.id}`);
});

test("a type that could run in the page is not served as it", async () => {
    const made = await create({ type: "text/html" });
    const fake = tab(made.id);
    const res = await get(made.path, "bytes=0-9");
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    await fake.stop();
});

test("when the tab cannot read, the player's stream is cut, not filled", async () => {
    const made = await create();
    const fake = tab(made.id, { fail: true });
    const res = await get(made.path).catch(() => ({ body: Buffer.alloc(0) }));
    assert.ok(res.body.length < VIDEO.length);
    await fake.stop();
});

test("the cache stays within its cap", async () => {
    const made = await create();
    const fake = tab(made.id);
    // a whole pass over 6 chunks with room for 4
    const whole = await get(made.path);
    assert.ok(whole.body.equals(VIDEO));
    const files = await readdir(join(dir, "play", made.id));
    assert.ok(files.length <= 4, `${files.length} chunks kept`);
    // reading the start again still works (asked of the tab again)
    const again = await get(made.path, "bytes=0-99");
    assert.ok(again.body.equals(VIDEO.subarray(0, 100)));
    await fake.stop();
});

test("closing, or a tab gone silent, deletes the cache", async () => {
    const made = await create();
    const fake = tab(made.id);
    await get(made.path, "bytes=0-9");
    assert.ok((await readdir(join(dir, "play"))).includes(made.id));
    await fake.stop();
    assert.ok(!(await readdir(join(dir, "play"))).includes(made.id));
    assert.equal((await get(made.path, "bytes=0-9")).status, 404);

    const silent = await create();
    clock += 120_000;
    await api.sweep();
    assert.ok(!(await readdir(join(dir, "play"))).includes(silent.id));
    assert.equal((await get(silent.path)).status, 404);
});

test("opening a fourth video closes the first", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await create()).id);
    const open = await readdir(join(dir, "play"));
    assert.ok(!open.includes(ids[0]));
    assert.ok(ids.slice(1).every((id) => open.includes(id)));
    for (const id of ids.slice(1)) await page("DELETE", `/api/play/${id}`);
});

test("a tab busy reading is not dropped while the player keeps asking", async () => {
    const made = await create();
    clock += 80_000;
    // the player asks (HEAD answers at once), the tab has not polled since
    assert.equal(
        (await fetch(base + made.path, { method: "HEAD" })).status,
        200,
    );
    clock += 80_000;
    await api.sweep();
    assert.ok((await readdir(join(dir, "play"))).includes(made.id));
    clock += 20_000;
    await api.sweep();
    assert.ok(!(await readdir(join(dir, "play"))).includes(made.id));
});

test("a chunk can come with the session's key instead of a cookie", async () => {
    const made = await create();
    assert.match(made.key, /^[A-Za-z0-9_-]{32}$/);
    const put = (key) =>
        fetch(`${base}/api/play/${made.id}/chunks/0`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/octet-stream",
                Origin: ORIGIN,
                ...(key ? { "X-Play-Key": key } : {}),
            },
            body: VIDEO.subarray(0, C),
        });
    // no cookie and no key; a wrong key; a key of another session
    assert.equal((await put()).status, 401);
    assert.equal((await put("x".repeat(32))).status, 404);
    const other = await create();
    assert.equal((await put(other.key)).status, 404);
    assert.equal((await put(made.key)).status, 200);
    // the poll takes the key too (the tab polls the direct address as well)
    const poll = (key) =>
        fetch(`${base}/api/play/${made.id}/next`, {
            headers: { Origin: ORIGIN, ...(key ? { "X-Play-Key": key } : {}) },
        });
    assert.equal((await poll()).status, 401);
    assert.equal((await poll("x".repeat(32))).status, 404);
    assert.equal((await poll(other.key)).status, 404);
    const polled = await poll(made.key);
    assert.equal(polled.status, 200);
    assert.deepEqual(await polled.json(), { index: null });
    // the player can read what was put, without asking the tab for it
    const first = await get(made.path, "bytes=0-9");
    assert.ok(first.body.equals(VIDEO.subarray(0, 10)));
    await page("DELETE", `/api/play/${made.id}`);
    await page("DELETE", `/api/play/${other.id}`);
});

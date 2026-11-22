import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudGramApi } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";

const dir = await mkdtemp(join(tmpdir(), "cg-diag-"));
const db = await new Db(dir).open();
const token = "fixture-session";
const key = createHash("sha256").update(token).digest("hex");
db.data.users.alice = { username: "alice", verifier: {} };
db.data.sessions[key] = {
    username: "alice",
    remember: true,
    expiresAt: Date.now() + 86400000,
};
await db.save();
const before = await readFile(db.file);
const beforeStat = await stat(db.file);
const lines = [];
const api = new CloudGramApi({ db, pepper: "p".repeat(40) });
const server = createApiServer(api, {
    origin: "https://cg.test",
    log: { log: (line) => lines.push(line) },
});
const offLines = [];
const off = createApiServer(api, {
    diagLog: false,
    log: { log: (line) => offLines.push(line) },
});
try {
    await Promise.all(
        [server, off].map(
            (s) =>
                new Promise((resolve, reject) =>
                    s.listen(0, "127.0.0.1", resolve).on("error", reject),
                ),
        ),
    );
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (body, headers = {}, url = base) =>
        fetch(url + "/api/log", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body),
        });
    const auth = { Cookie: `cg_session=${token}`, Origin: "https://cg.test" };
    assert.equal((await call({ events: [] })).status, 401);
    assert.equal(
        (await call({ events: [] }, { ...auth, Origin: "https://evil.test" }))
            .status,
        403,
    );
    assert.equal(
        (await call("x", { ...auth, "Content-Type": "text/plain" })).status,
        415,
    );
    assert.equal(
        (await call({ events: Array(101).fill({ evt: "diag.start" }) }, auth))
            .status,
        400,
    );
    assert.equal(
        (
            await call(
                JSON.stringify({ events: [], padding: "x".repeat(33000) }),
                auth,
            )
        ).status,
        413,
    );
    const bad = [
        "IMG_1234.jpg",
        "https://example.invalid/?token=secret",
        { nested: "secret" },
        "x".repeat(1000),
    ];
    const valid = await call(
        {
            events: [
                { evt: "diag.start", tab: "abc12345" },
                ...bad.map((value) => ({ evt: "err.global", errName: value })),
                { evt: "secret-unknown-event" },
            ],
        },
        auth,
    );
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).dropped, 5);
    assert.equal(
        lines.map(JSON.parse).filter((line) => line.src === "client").length,
        5,
    );
    for (const secret of [
        "IMG_1234.jpg",
        "token=secret",
        "nested",
        "x".repeat(1000),
        "secret-unknown-event",
    ])
        assert.equal(lines.join("\n").includes(secret), false);
    assert(lines.some((line) => JSON.parse(line).ev?.tab === "abc12345"));
    const accepted = lines
        .map(JSON.parse)
        .find((line) => line.ev?.tab === "abc12345");
    assert.equal(
        accepted.acct,
        createHmac("sha256", api.pepper)
            .update("alice")
            .digest("hex")
            .slice(0, 8),
    );
    assert.deepEqual(await readFile(db.file), before);
    assert.equal((await stat(db.file)).mtimeMs, beforeStat.mtimeMs);
    await fetch(base + "/api/s/sensitiveToken?password=secret");
    const access = lines
        .map(JSON.parse)
        .find(
            (line) => line.src === "api" && line.route === "shares.publicMeta",
        );
    assert(access);
    assert(!JSON.stringify(access).includes("sensitiveToken"));
    assert(!JSON.stringify(access).includes("password"));
    const routes = [
        ["PUT", "/api/shares/TOKENVALUE/chunks/0", "shares.putChunk"],
        ["POST", "/api/shares/TOKENVALUE/complete", "shares.complete"],
        ["DELETE", "/api/shares/TOKENVALUE", "shares.remove"],
        ["GET", "/api/play/TOKENVALUE/next", "play.next"],
        ["PUT", "/api/play/TOKENVALUE/chunks/0", "play.putChunk"],
        ["POST", "/api/play/TOKENVALUE/fail", "play.fail"],
        ["DELETE", "/api/play/TOKENVALUE", "play.close"],
        ["GET", "/api/p/TOKENVALUE/secret-name", "play.open"],
        ["GET", "/api/s/TOKENVALUE", "shares.publicMeta"],
        ["GET", "/api/s/TOKENVALUE/0", "shares.publicChunk"],
    ];
    for (const [method, path, label] of routes) {
        const beforeLines = lines.length;
        const raw = method === "PUT";
        const response = await fetch(base + path, {
            method,
            headers: {
                ...auth,
                ...(method === "GET"
                    ? {}
                    : {
                          "Content-Type": raw
                              ? "application/octet-stream"
                              : "application/json",
                      }),
            },
            ...(method === "GET" ? {} : { body: raw ? "raw" : "{}" }),
        });
        await response.arrayBuffer();
        const entries = lines
            .slice(beforeLines)
            .map(JSON.parse)
            .filter((line) => line.src === "api" && !line.lvl);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].route, label);
        assert.match(entries[0].route, /^[A-Za-z]+(?:\.[A-Za-z]+)?$/);
        assert(!JSON.stringify(entries[0]).includes("TOKENVALUE"));
    }
    assert(!lines.join("\n").includes("TOKENVALUE"));
    assert(!lines.join("\n").includes("secret-name"));
    assert(lines.map(JSON.parse).some((line) => line.code === "not_signed_in"));
    assert(lines.map(JSON.parse).some((line) => line.code === "bad_batch"));
    api.prelogin = () => {
        throw new Error("SECRET /private/path");
    };
    const errorStart = lines.length;
    assert.equal(
        (
            await fetch(base + "/api/auth/prelogin", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
            })
        ).status,
        500,
    );
    const errors = lines.map(JSON.parse).filter((line) => line.lvl === "error");
    assert.equal(errors.length, 1);
    assert(!JSON.stringify(errors[0]).includes("SECRET"));
    assert(!JSON.stringify(errors[0]).includes("/private/path"));
    assert.equal(
        lines
            .slice(errorStart)
            .map(JSON.parse)
            .filter((line) => line.src === "api" && !line.lvl).length,
        1,
    );
    api.diagBySession.hits.clear();
    for (let i = 0; i < 30; i++)
        assert.equal((await call({ events: [] }, auth)).status, 200);
    assert.equal((await call({ events: [] }, auth)).status, 429);
    const disabled = `http://127.0.0.1:${off.address().port}`;
    assert.equal(
        (await call({ events: [{ evt: "diag.start" }] }, {}, disabled)).status,
        204,
    );
    assert.deepEqual(offLines, []);
    console.log("diagnostic API tests passed");
} finally {
    await Promise.all(
        [server, off].map((s) => new Promise((resolve) => s.close(resolve))),
    );
    await rm(dir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudGramApi } from "../app.js";
import { Db } from "../db.js";
import { createApiServer } from "../http.js";

const dir = await mkdtemp(join(tmpdir(), "cg-stream-"));
const db = await new Db(dir).open();
const api = new CloudGramApi({ db, pepper: "p".repeat(40) });
const cookie = "stream-session";
const key = createHash("sha256").update(cookie).digest("hex");
const userId = "a".repeat(32);
const shareId = "b".repeat(22);
db.data.users.alice = { username: "alice", id: userId, verifier: {} };
db.data.sessions[key] = { username: "alice", expiresAt: Date.now() + 86400000 };
db.data.shares[shareId] = {
    owner: "alice",
    chunks: 1,
    complete: false,
    createdAt: Date.now(),
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
const lines = [];
const on = createApiServer(api, {
    origin: "https://cg.test",
    log: { log: (line) => lines.push(JSON.parse(line)) },
});
const off = createApiServer(api, {
    origin: "https://cg.test",
    diagLog: false,
    log: { log() {} },
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const upload = (port, path, body, type, abort = false) =>
    new Promise((resolve, reject) => {
        const req = request(
            {
                hostname: "127.0.0.1",
                port,
                path,
                method: "PUT",
                headers: {
                    "Content-Type": type,
                    "Content-Length": body.length,
                    Cookie: `cg_session=${cookie}`,
                    Origin: "https://cg.test",
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        );
        req.on("error", (err) =>
            abort ? resolve({ aborted: true }) : reject(err),
        );
        (async () => {
            for (let i = 0; i < body.length; i += 65536) {
                if (!req.write(body.subarray(i, i + 65536)))
                    await new Promise((r) => req.once("drain", r));
                if (abort) {
                    await wait(20);
                    req.destroy();
                    return;
                }
                await wait(1);
            }
            req.end();
        })().catch(reject);
    });
try {
    await Promise.all(
        [on, off].map(
            (server) =>
                new Promise((resolve, reject) =>
                    server
                        .listen(0, "127.0.0.1", resolve)
                        .once("error", reject),
                ),
        ),
    );
    const contents = "A".repeat(4 * 1024 * 1024);
    const raw = Buffer.alloc(4 * 1024 * 1024, 0xa5);
    for (const [server, enabled, version] of [
        [on, true, 0],
        [off, false, 1],
    ]) {
        const port = server.address().port;
        const body = Buffer.from(
            JSON.stringify({
                tree: { iv: "AA==", ct: contents },
                baseVersion: version,
            }),
        );
        const first = lines.length;
        assert.equal(
            (await upload(port, "/api/vault/tree", body, "application/json"))
                .status,
            200,
        );
        assert.equal(hash((await db.readTree(userId)).ct), hash(contents));
        if (enabled) {
            const access = lines
                .slice(first)
                .filter((line) => line.src === "api" && !line.lvl);
            assert.equal(access.length, 1);
            assert.equal(access[0].in, body.length);
        }
        const rawStart = lines.length;
        assert.equal(
            (
                await upload(
                    port,
                    `/api/shares/${shareId}/chunks/0`,
                    raw,
                    "application/octet-stream",
                )
            ).status,
            200,
        );
        const stored = await (
            await import("node:fs/promises")
        ).readFile(db.chunkPath(shareId, 0));
        assert.equal(hash(stored), hash(raw));
        if (enabled) {
            const access = lines
                .slice(rawStart)
                .filter((line) => line.src === "api" && !line.lvl);
            assert.equal(access.length, 1);
            assert.equal(access[0].in, raw.length);
        }
        db.data.shares[shareId].complete = true;
        const start = lines.length;
        const response = await fetch(
            `http://127.0.0.1:${port}/api/s/${shareId}/0`,
        );
        assert.equal(response.status, 200);
        assert.equal(
            hash(Buffer.from(await response.arrayBuffer())),
            hash(raw),
        );
        await wait(20);
        if (enabled) {
            const access = lines
                .slice(start)
                .filter((line) => line.src === "api" && !line.lvl);
            assert.equal(access.length, 1);
            assert.equal(access[0].out, raw.length);
        }
        db.data.shares[shareId].complete = false;
    }
    const start = lines.length;
    let unhandled = 0;
    const onUnhandled = () => {
        unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    await upload(
        on.address().port,
        "/api/vault/tree",
        Buffer.alloc(4 * 1024 * 1024, 65),
        "application/json",
        true,
    );
    await wait(100);
    process.off("unhandledRejection", onUnhandled);
    assert.equal(unhandled, 0);
    assert.equal(
        lines.slice(start).filter((line) => line.src === "api" && !line.lvl)
            .length,
        1,
    );
    console.log(
        "diagnostic stream tests passed: JSON, raw, streamed response, abort (on/off)",
    );
} finally {
    await Promise.all(
        [on, off].map(
            (server) => new Promise((resolve) => server.close(resolve)),
        ),
    );
    await rm(dir, { recursive: true, force: true });
}

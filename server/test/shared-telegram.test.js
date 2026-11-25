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

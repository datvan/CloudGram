import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { sanitizeDiag } from "../diagSchema.js";

const source = (
    await readFile(
        new URL("../../src/services/tgProxy.js", import.meta.url),
        "utf8",
    )
)
    .replace(/^import .*;\s*$/gm, "")
    .replace(/\bexport /g, "");

function setup(origin, handler) {
    let now = 0;
    const calls = [],
        events = [];
    class ApiError extends Error {
        constructor(status, code) {
            super(code);
            this.status = status;
            this.code = code;
        }
    }
    const context = vm.createContext({
        ApiError,
        Uint8Array,
        AbortController,
        PLAY_DIRECT: origin,
        browserId: () => "browser",
        diag: (...args) => events.push(args),
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        fetch: (url, options) => {
            calls.push({ url, options });
            return handler(url, options, calls);
        },
        setTimeout,
        clearTimeout,
    });
    vm.runInContext(
        source + "\nglobalThis.subject = { readFile, thumb, resetReadKey };",
        context,
    );
    return {
        ...context.subject,
        calls,
        events,
        advance: (ms) => {
            now += ms;
        },
    };
}
const key = (value = "secret") => ({
    ok: true,
    json: async () => ({ readKey: value, expiresIn: 3600 }),
});
const bytes = () => ({
    ok: true,
    arrayBuffer: async () => Uint8Array.of(1).buffer,
});
const missing = () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "not_found" }),
});

test("direct reads share a key, use no cookies, and refresh before expiry", async () => {
    let keys = 0;
    const s = setup("https://up.example", async (url) =>
        url.endsWith("/read-key") ? key(String(++keys)) : bytes(),
    );
    await Promise.all([s.readFile(7, 1, 2), s.thumb(7)]);
    assert.equal(keys, 1);
    assert.equal(s.calls[0].options.headers["X-CloudGram-Browser"], "browser");
    assert.equal(s.calls[0].options.credentials, "same-origin");
    assert.deepEqual(
        s.calls.slice(1).map((c) => c.url),
        [
            "https://up.example/api/tgxd/file/7?offset=1&limit=2",
            "https://up.example/api/tgxd/thumb/7",
        ],
    );
    for (const call of s.calls.slice(1)) {
        assert.equal(call.options.credentials, "omit");
        assert.equal(call.options.headers["X-Read-Key"], "1");
    }
    s.advance(3570000);
    await s.thumb(7);
    assert.equal(keys, 2);
});

test("without direct origin reads use same-origin", async () => {
    const s = setup("", async () => bytes());
    await s.thumb(7);
    assert.equal(s.calls[0].url, "/api/tgx/thumb/7");
    assert.equal(s.calls[0].options.credentials, "same-origin");
});

test("reset discards cached and pending keys and clears fallback cooldown", async () => {
    let count = 0,
        resolveOld;
    const s = setup("https://up.example", async (url) => {
        if (url.endsWith("/read-key")) {
            count++;
            if (count === 2)
                return new Promise((resolve) => (resolveOld = resolve));
            return key(String(count));
        }
        return bytes();
    });
    await s.thumb(7);
    s.resetReadKey();
    const old = s.thumb(7);
    s.resetReadKey();
    await s.thumb(7);
    resolveOld(key("old"));
    await assert.rejects(old, { name: "AbortError" });
    await s.thumb(7);
    assert.deepEqual(
        s.calls
            .filter((c) => c.url.includes("/tgxd/"))
            .map((c) => c.options.headers["X-Read-Key"]),
        ["1", "3", "3"],
    );

    let fail = true;
    const fallback = setup("https://up.example", async (url) => {
        if (url.endsWith("/read-key")) return key();
        if (url.startsWith("https://") && fail) throw new TypeError("network");
        return bytes();
    });
    await fallback.thumb(7);
    fail = false;
    fallback.resetReadKey();
    await fallback.thumb(7);
    assert.equal(
        fallback.calls.filter((c) => c.url.startsWith("https://")).length,
        2,
    );
});

test("not_found replaces key and retries once", async () => {
    let keys = 0,
        reads = 0;
    const s = setup("https://up.example", async (url) =>
        url.endsWith("/read-key")
            ? key(String(++keys))
            : ++reads === 1
            ? missing()
            : bytes(),
    );
    await s.thumb(7);
    assert.equal(keys, 2);
    assert.deepEqual(
        s.calls
            .filter((c) => c.url.includes("/tgxd/"))
            .map((c) => c.options.headers["X-Read-Key"]),
        ["1", "2"],
    );
});

test("network failure falls back once and cooldown ends after five minutes", async () => {
    let fail = true;
    const s = setup("https://up.example", async (url) => {
        if (url.endsWith("/read-key")) return key();
        if (url.startsWith("https://") && fail) throw new TypeError("network");
        return bytes();
    });
    await s.readFile(7, 0, 1);
    await s.thumb(7);
    assert.equal(s.events.length, 1);
    assert.equal(s.events[0][0], "read.direct.fallback");
    assert.deepEqual(
        sanitizeDiag({
            evt: s.events[0][0],
            key: "secret",
            url: "hidden",
            id: 7,
        }),
        { event: { evt: "read.direct.fallback" }, dropped: 3 },
    );
    assert.equal(s.calls.filter((c) => c.url.startsWith("https://")).length, 1);
    s.advance(300000);
    fail = false;
    await s.thumb(7);
    assert.equal(s.calls.filter((c) => c.url.startsWith("https://")).length, 2);
});

test("aborting while waiting for key never falls back", async () => {
    const s = setup("https://up.example", () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = s.thumb(7, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(s.calls.length, 1);
    assert.equal(s.events.length, 0);
});

test("disabled key route falls back and direct 429 retries", async () => {
    const disabled = setup("https://up.example", async (url) =>
        url.endsWith("/read-key") ? missing() : bytes(),
    );
    await disabled.thumb(7);
    assert.equal(disabled.calls.at(-1).url, "/api/tgx/thumb/7");
    assert.equal(disabled.events.length, 1);

    let reads = 0;
    const limited = setup("https://up.example", async (url) => {
        if (url.endsWith("/read-key")) return key();
        if (++reads === 1)
            return {
                ok: false,
                status: 429,
                headers: { get: () => "0" },
                json: async () => ({ error: "rate_limited" }),
            };
        return bytes();
    });
    await limited.thumb(7);
    assert.equal(reads, 2);
    assert.equal(limited.events.length, 0);
});

test("nginx routes direct reads before uploads with isolated limits", async () => {
    const conf = await readFile(
        new URL("../../deploy/nginx/cloudgram-upload.conf", import.meta.url),
        "utf8",
    );
    const read = conf.indexOf('location ~ "^/api/tgxd/(file|thumb)/[0-9]+$"');
    const upload = conf.indexOf(
        'location ~ "^/api/tgxd/[A-Za-z0-9_-]+/[0-9]+$"',
    );
    assert.ok(read >= 0 && read < upload);
    const block = conf.slice(read, upload);
    for (const value of [
        "GET, OPTIONS",
        "X-Read-Key",
        "return 204",
        "burst=60 nodelay",
        "limit_conn cg_tgx_read_conn 16",
        "client_max_body_size 1k",
        "proxy_read_timeout 90s",
        "proxy_pass http://127.0.0.1:4322",
    ])
        assert.ok(block.includes(value), value);
    assert.match(conf, /zone=cg_tgx_read:1m rate=30r\/s/);
});

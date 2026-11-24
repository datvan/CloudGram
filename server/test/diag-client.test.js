import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { sanitizeDiag } from "../diagSchema.js";

async function load(enabled = true) {
    const source = (
        await readFile(
            new URL("../../src/services/diag.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const listeners = {};
    const calls = [];
    let scope = {};
    let timer;
    let responder = () => ({ ok: true, status: 200 });
    const window = { addEventListener: (name, fn) => (listeners[name] = fn) };
    const document = {
        visibilityState: "visible",
        addEventListener: (name, fn) => (listeners[name] = fn),
    };
    const context = vm.createContext({
        sanitizeDiag,
        DIAG_LOG: enabled,
        UPLOAD_OWNER: true,
        LOG_OWNER: false,
        window,
        document,
        navigator: { userAgent: "Chrome/131.0" },
        performance: { now: () => 15 },
        setInterval: (fn) => (timer = fn),
        fetch: (...args) => {
            calls.push(args);
            return responder(...args);
        },
    });
    const api = vm.runInContext(
        `${source}\n;({diag, diagRun, setDiagScope, downloadDiag, sanitizeDiag})`,
        context,
    );
    api.setDiagScope(() => scope);
    const tick = async (fn = timer) => {
        fn();
        await new Promise(setImmediate);
    };
    return {
        api,
        calls,
        listeners,
        document,
        tick: () => tick(timer),
        fire: (name, value) => tick(() => listeners[name](value)),
        setScope: (value) => (scope = value),
        setResponse: (fn) => (responder = fn),
    };
}
const events = (calls) =>
    calls.flatMap(([, options]) => JSON.parse(options.body).events);

test("filters private data and never throws", async () => {
    const h = await load();
    const circular = {};
    circular.self = circular;
    h.api.diag("diag.start", {
        filename: "IMG_1234.jpg",
        url: "https://example.com/?token=secret",
        nested: circular,
        errName: "x".repeat(100000),
    });
    h.api.diag("unknown", circular);
    h.listeners.error({ error: new Error("C:\\private\\file") });
    h.listeners.unhandledrejection({
        reason: { name: "Bad/name", message: "secret" },
    });
    await h.tick();
    const body = JSON.stringify(h.calls);
    for (const secret of ["IMG_1234", "token", "private", "secret"])
        assert.equal(body.includes(secret), false);
    assert.equal(
        events(h.calls).filter((e) => e.evt === "err.global").length,
        2,
    );
    assert.match(h.api.diagRun(), /^[0-9a-z]{6}$/);
    assert.match(events(h.calls)[0].build, /^[0-9a-f]{7,12}(-dirty)?$/);
});

test("caps ring, sends sequential batches and preserves order", async () => {
    const h = await load();
    for (let i = 0; i < 250; i++)
        h.api.diag("err.global", {
            errName: "A".repeat(39),
            run: "a".repeat(12),
            file: "b".repeat(12),
            req: "c".repeat(12),
            errCode: "D".repeat(39),
        });
    await h.tick();
    assert.ok(h.calls.length >= 3);
    assert.ok(JSON.parse(h.calls[0][1].body).events.length < 100);
    for (const [, options] of h.calls) {
        assert.ok(Buffer.byteLength(options.body) < 25 * 1024);
        assert.ok(JSON.parse(options.body).events.length <= 100);
        assert.equal(options.keepalive, true);
        assert.equal(options.credentials, "same-origin");
    }
    const seqs = events(h.calls).map((e) => e.seq);
    assert.deepEqual(
        seqs,
        [...seqs].sort((a, b) => a - b),
    );
    assert.equal(seqs.length, 251);
    for (let i = 0; i < 600; i++) h.api.diag("diag.start");
    assert.equal(JSON.parse(h.api.downloadDiag()).length, 500);
    await h.fire("pagehide");
    assert.ok(h.calls.length > 3);
});

test("failure is dropped and reported later; 401 waits for new scope", async () => {
    const h = await load();
    h.api.diag("diag.start");
    h.setResponse(() => {
        throw new Error("offline");
    });
    await h.tick();
    h.setResponse(() => ({ ok: true, status: 200 }));
    await h.tick();
    assert.equal(events(h.calls).at(-1).evt, "diag.lost");
    assert.equal(events(h.calls).at(-1).n, 2);
    h.api.diag("diag.start");
    h.setResponse(() => ({ ok: false, status: 401 }));
    await h.tick();
    const count = h.calls.length;
    h.api.diag("diag.start");
    await h.tick();
    assert.equal(h.calls.length, count);
    h.setScope({});
    h.setResponse(() => ({ ok: true, status: 200 }));
    h.api.diag("diag.start");
    await h.tick();
    assert.equal(h.calls.length, count + 1);
});

test("scope mismatch and null discard queued events", async () => {
    const h = await load();
    h.api.diag("diag.start");
    h.setScope({});
    await h.tick();
    assert.equal(h.calls.length, 0);
    h.api.diag("diag.start");
    h.setScope(null);
    await h.tick();
    assert.equal(h.calls.length, 0);
});

for (const status of [413, 429, 500]) {
    test(`HTTP ${status} drops its batch and reports loss`, async () => {
        const h = await load();
        h.api.diag("diag.start");
        h.setResponse(() => ({ ok: false, status }));
        await h.tick();
        h.setResponse(() => ({ ok: true, status: 200 }));
        await h.tick();
        assert.equal(events(h.calls).at(-1).n, 2);
    });
}

test("hidden visibility sends pending events", async () => {
    const h = await load();
    h.api.diag("diag.start");
    h.document.visibilityState = "hidden";
    await h.fire("visibilitychange");
    assert.equal(h.calls.length, 1);
});

test("disabled flag installs nothing", async () => {
    const h = await load(false);
    h.api.diag("diag.start");
    assert.deepEqual(Object.keys(h.listeners), []);
    assert.equal(h.calls.length, 0);
    assert.equal(h.api.downloadDiag(), "[]");
});

test("browser uses server sanitizer on representative fixtures", async () => {
    const h = await load();
    for (const fixture of [
        null,
        { evt: "bad" },
        { evt: "err.global", errName: "TypeError", file: "IMG_1234.jpg", n: 4 },
        { evt: "diag.lost", n: 9, run: "abc123" },
    ]) {
        const expected = sanitizeDiag(fixture);
        assert.deepEqual(h.api.sanitizeDiag(fixture), expected);
    }
});

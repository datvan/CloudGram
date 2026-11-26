import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { Api } from "telegram";
import { Buffer } from "buffer";
import { sanitizeDiag } from "../diagSchema.js";

test("plain rate limits are parsed and proxy reads retry, abort and stop at the cap", async () => {
    const apiSource = (
        await readFile(
            new URL("../../src/services/api.js", import.meta.url),
            "utf8",
        )
    ).replace(/\bexport /g, "");
    const proxySource = (
        await readFile(
            new URL("../../src/services/tgProxy.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import .*;\s*$/gm, "")
        .replace(/\bexport /g, "");
    let calls = 0,
        now = 0,
        mode = "success";
    const waits = [];
    const rate = () => ({
        ok: false,
        status: 429,
        headers: { get: () => "7" },
        json: async () => {
            throw new Error("plain");
        },
    });
    const context = vm.createContext({
        Uint8Array,
        AbortController,
        browserId: () => "browser",
        PLAY_DIRECT: "",
        diag() {},
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        fetch: async () => {
            calls++;
            return mode === "success" && calls > 1
                ? {
                      ok: true,
                      arrayBuffer: async () => Uint8Array.of(1, 2).buffer,
                  }
                : rate();
        },
        setTimeout: (fn, ms) => {
            waits.push(ms);
            if (mode === "abort") return setTimeout(fn, ms);
            now += ms;
            return setTimeout(fn, 0);
        },
        clearTimeout,
    });
    vm.runInContext(
        `const { ApiError, parse } = (() => { ${apiSource}\nreturn { ApiError, parse }; })();\n${proxySource}\nglobalThis.subject = { parse, readFile, thumb, putPart };`,
        context,
    );
    const { parse, readFile: readProxyFile, thumb, putPart } = context.subject;
    for (const action of [
        () => parse(rate()),
        () => putPart("x", 0, new Uint8Array()),
    ])
        await assert.rejects(
            action(),
            (e) =>
                e.status === 429 &&
                e.code === "rate_limited" &&
                e.retryAfter === 7,
        );
    for (const [status, code] of [
        [502, "server_down"],
        [403, "bad_response"],
    ]) {
        const response = { ...rate(), status };
        await assert.rejects(
            parse(response),
            (e) => e.status === status && e.code === code,
        );
    }
    calls = 0;
    assert.deepEqual(Array.from(await readProxyFile(1, 0, 2)), [1, 2]);
    assert.equal(waits.at(-1), 7000);
    calls = 0;
    now = 0;
    mode = "abort";
    const controller = new AbortController();
    const pending = thumb(1, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    calls = 0;
    now = 0;
    mode = "cap";
    await assert.rejects(readProxyFile(1, 0, 2), (e) => e.status === 429);
    assert.ok(now <= 60000 && now >= 53000);
});

test("proxy upload, range, thumbnail and deletion use owned HTTP routes", async () => {
    const calls = [];
    const parts = [];
    let active = 0,
        maxActive = 0,
        retried = false;
    let hold = false;
    let partError;
    let leaseErrors = 0;
    let leaseCalls = 0;
    let leaseStatus = "granted";
    let rateFailures = 0;
    let partCalls = 0;
    let finishFailures = [];
    let finishCalls = 0;
    let finishStarted;
    let releaseFinish;
    const waits = [];
    let now = 0;
    let stored;
    const fetch = async (url, options) => {
        calls.push(url);
        assert.equal(options.headers["X-CloudGram-Browser"], "browser");
        let result = {};
        if (url.endsWith("/upload/start")) result = { uploadId: "u" };
        else if (/\/upload\/u\/\d+$/.test(url)) {
            partCalls += 1;
            if (leaseErrors-- > 0)
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({ error: "lease_required" }),
                };
            if (rateFailures-- > 0)
                return {
                    ok: false,
                    status: 429,
                    headers: { get: () => "10" },
                    json: async () => {
                        throw new Error("text/plain");
                    },
                };
            if (partError) {
                const error = partError;
                partError = null;
                return {
                    ok: false,
                    status: error.status,
                    json: async () => error.body,
                };
            }
            if (hold)
                await new Promise((resolve, reject) => {
                    options.signal.addEventListener(
                        "abort",
                        () => reject(options.signal.reason),
                        { once: true },
                    );
                });
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active -= 1;
            if (url.endsWith("/0") && !retried) {
                retried = true;
                return {
                    ok: false,
                    status: 503,
                    json: async () => ({ error: "busy" }),
                };
            }
            parts[Number(url.split("/").pop())] = Buffer.from(options.body);
        } else if (url.endsWith("/finish")) {
            finishCalls += 1;
            if (finishStarted) {
                finishStarted();
                await new Promise((resolve, reject) => {
                    releaseFinish = resolve;
                    options.signal?.addEventListener("abort", () =>
                        reject(options.signal.reason),
                    );
                });
            }
            const failure = finishFailures.shift();
            if (failure === "network") throw new TypeError("network error");
            if (failure)
                return {
                    ok: false,
                    status: failure.status,
                    json: async () => ({ error: failure.code }),
                };
            stored = Buffer.concat(parts.filter(Boolean));
            const metadata = JSON.parse(options.body);
            result = {
                message: {
                    id: 42,
                    date: 1,
                    size: stored.length,
                    name: metadata.name,
                    mime: metadata.mime,
                    hasThumb: true,
                },
            };
        } else if (url.endsWith("/messages"))
            result = {
                messages: [
                    {
                        id: 42,
                        date: 1,
                        size: stored.length,
                        name: "cipher",
                        mime: "application/octet-stream",
                        hasThumb: true,
                    },
                    null,
                ],
            };
        else if (url.includes("/file/")) {
            const query = new URL(url, "https://example.test").searchParams;
            result = stored.subarray(
                Number(query.get("offset")),
                Number(query.get("offset")) + Number(query.get("limit")),
            );
        } else if (url.includes("/thumb/")) result = Buffer.from([8, 9]);
        else if (url.endsWith("/delete")) result = { deleted: [42] };
        return {
            ok: true,
            json: async () => result,
            arrayBuffer: async () => Uint8Array.from(result).buffer,
        };
    };
    const proxySource = (
        await readFile(
            new URL("../../src/services/tgProxy.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import .*;\s*$/gm, "")
        .replaceAll("export const ", "const ")
        .replaceAll("export function ", "function ");
    const clientSource = (
        await readFile(
            new URL("../../src/services/proxyClient.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import .*;\s*$/gm, "")
        .replace(
            "export function createProxyClient",
            "function createProxyClient",
        );
    class ApiError extends Error {
        constructor(status, message, body) {
            super(message);
            this.status = status;
            this.code = message;
            this.body = body;
        }
    }
    const context = vm.createContext({
        Api,
        Buffer,
        Uint8Array,
        fetch,
        ApiError,
        browserId: () => "browser",
        PLAY_DIRECT: "",
        diag() {},
        api: {
            lease: async (id, takeover) => {
                assert.equal(id, "browser");
                assert.equal(takeover, false);
                leaseCalls++;
                return { status: leaseStatus };
            },
        },
        AbortController,
        AbortSignal,
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        setTimeout: (fn, ms) => {
            waits.push(ms);
            if (ms >= 500) now += ms;
            return setTimeout(fn, ms >= 500 ? 0 : ms);
        },
        clearTimeout,
    });
    vm.runInContext(
        `${proxySource}\r\nconst proxy = { startUpload, putPart, finishUpload, cancelUpload, getMessages, readFile, thumb, deleteMessages };\r\n${clientSource}\r\nglobalThis.create = createProxyClient;`,
        context,
    );
    const client = context.create();
    const bytes = Buffer.alloc(25 * 524288 + 1, 123);
    const file = new Blob([bytes]);
    file.name = "cipher";
    const progress = [];
    const stats = { waits: [], reconnects: 0, retries: 0 };
    const token = await client.proxyUpload(file, {
        onProgress: (n) => progress.push(n),
        stats,
    });
    const sent = await client.sendFile("me", {
        file: token,
        forceDocument: true,
    });
    assert.equal(parts[0].length, 8 * 524288);
    assert.equal(parts[24].length, 524289);
    assert.equal(maxActive, 4);
    assert.equal(stats.bytes, bytes.length);
    assert.equal(stats.parts, 26);
    assert.equal(stats.retries, 1);
    assert.ok(
        progress.every((value, i) => i === 0 || value >= progress[i - 1]),
    );
    assert.equal(progress.at(-1), 1);
    const [found, missing] = await client.getMessages("me", { ids: [42, 43] });
    assert.equal(missing, undefined);
    assert.deepEqual(
        Buffer.from(await client.downloadMedia(found.media)),
        bytes,
    );
    const location = new Api.InputDocumentFileLocation({
        id: sent.media.document.id,
        accessHash: 0,
        fileReference: Buffer.alloc(0),
        thumbSize: "",
    });
    const range = await client.invoke(
        new Api.upload.GetFile({ location, offset: 500, limit: 1024 }),
    );
    assert.deepEqual(Buffer.from(range.bytes), bytes.subarray(500, 1524));
    assert.deepEqual(
        Buffer.from(await client.downloadMedia(found.media, { thumb: {} })),
        Buffer.from([8, 9]),
    );
    await client.deleteMessages("me", [42]);
    hold = true;
    const controller = new AbortController();
    const aborted = client.proxyUpload(file, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(aborted, { name: "AbortError" });
    assert.ok(calls.includes("/api/tgx/upload/u/cancel"));
    assert.ok(calls.every((url) => url.startsWith("/api/tgx/")));
    assert.ok(calls.includes("/api/tgx/delete"));

    hold = false;
    const small = new Blob(["x"]);
    small.name = "small";
    partCalls = 0;
    leaseErrors = 1;
    await client.proxyUpload(small);
    assert.equal(partCalls, 2);
    assert.equal(leaseCalls, 1);
    partCalls = 0;
    leaseErrors = 2;
    await assert.rejects(
        client.proxyUpload(small),
        (error) =>
            error instanceof ApiError &&
            error.status === 409 &&
            error.code === "lease_required",
    );
    assert.equal(partCalls, 2);
    assert.equal(leaseCalls, 2);
    partCalls = 0;
    leaseErrors = 1;
    leaseStatus = "busy";
    await assert.rejects(
        client.proxyUpload(small),
        (error) => error.code === "lease_required",
    );
    assert.equal(partCalls, 1);
    leaseStatus = "granted";
    partError = { status: 429, body: { error: "busy", seconds: 3 } };
    await client.proxyUpload(small);
    assert.ok(waits.includes(3000));

    rateFailures = 6;
    partCalls = 0;
    await client.proxyUpload(small);
    assert.equal(partCalls, 7);
    assert.ok(waits.includes(10000));

    finishFailures = ["network", { status: 502, code: "server_down" }];
    finishCalls = 0;
    assert.equal((await client.sendFile("me", { file: token })).id, 42);
    assert.equal(finishCalls, 3);
    finishFailures = [
        { status: 504, code: "bad_response" },
        { status: 409, code: "busy" },
    ];
    finishCalls = 0;
    assert.equal((await client.sendFile("me", { file: token })).id, 42);
    assert.equal(finishCalls, 3);
    finishFailures = [{ status: 409, code: "chunk_missing" }];
    finishCalls = 0;
    await assert.rejects(client.sendFile("me", { file: token }), {
        code: "chunk_missing",
    });
    assert.equal(finishCalls, 1);
    finishFailures = Array(100).fill("network");
    finishCalls = 0;
    const startedAt = now;
    await assert.rejects(client.sendFile("me", { file: token }), { status: 0 });
    assert.equal(now - startedAt, 180000);
    assert.ok(finishCalls > 4);
    finishFailures = [{ status: 503, code: "telegram_busy" }];
    finishCalls = 0;
    await assert.rejects(client.sendFile("me", { file: token }), {
        code: "telegram_busy",
    });
    assert.equal(finishCalls, 1);

    const finishingClient = context.create();
    const started = new Promise((resolve) => (finishStarted = resolve));
    const finishing = finishingClient.sendFile("me", { file: token });
    await started;
    finishingClient.destroy();
    releaseFinish();
    assert.equal((await finishing).id, 42);
    await assert.rejects(finishingClient.sendFile("me", { file: token }), {
        message: "Telegram is not connected",
    });
    finishStarted = null;

    hold = true;
    const inFlight = client.proxyUpload(small);
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.destroy();
    await assert.rejects(inFlight, { message: "Telegram is not connected" });
    assert.equal(client.connected, false);
    const count = calls.length;
    for (const call of [
        () => client.proxyUpload(small),
        () => client.sendFile("me", {}),
        () => client.getMessages("me", { ids: [1] }),
        () => client.deleteMessages("me", [1]),
        () => client.invoke({}),
        () => client.downloadMedia({}),
        () => client.getSender(),
        () => client.getMe(),
        () => client.iterMessages(),
        () => client._borrowExportedSender(),
        () => client.auth.signIn(),
    ])
        await assert.rejects(call(), { message: "Telegram is not connected" });
    assert.equal(calls.length, count);
});

test("direct upload selects origin, falls back only on network failure and preserves HTTP retries", async () => {
    const proxySource = (
        await readFile(
            new URL("../../src/services/tgProxy.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import .*;\s*$/gm, "")
        .replaceAll("export const ", "const ")
        .replaceAll("export function ", "function ");
    const clientSource = (
        await readFile(
            new URL("../../src/services/proxyClient.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import .*;\s*$/gm, "")
        .replace(
            "export function createProxyClient",
            "function createProxyClient",
        );
    class ApiError extends Error {
        constructor(status, code, body) {
            super(code);
            Object.assign(this, { status, code, body });
        }
    }
    async function run({
        origin = "https://up.example",
        key = "secret",
        failures = [],
        abort = false,
    } = {}) {
        const calls = [],
            events = [],
            waits = [];
        let leases = 0;
        const controller = new AbortController();
        const context = vm.createContext({
            Api,
            Buffer,
            Uint8Array,
            ApiError,
            AbortController,
            AbortSignal,
            clearTimeout,
            PLAY_DIRECT: origin,
            browserId: () => "browser",
            diag: (...args) => events.push(args),
            api: {
                lease: async () => {
                    leases++;
                    return { status: "granted" };
                },
            },
            setTimeout: (fn, ms) => {
                waits.push(ms);
                return setTimeout(fn, 0);
            },
            fetch: async (url, options) => {
                calls.push({ url, options });
                if (url.endsWith("/start"))
                    return {
                        ok: true,
                        json: async () => ({ uploadId: "u", directKey: key }),
                    };
                if (url.includes("/cancel"))
                    return { ok: true, json: async () => ({}) };
                const failure = failures.shift();
                if (abort) {
                    controller.abort();
                    throw controller.signal.reason;
                }
                if (failure === "network") throw new TypeError("network");
                if (failure)
                    return {
                        ok: false,
                        status: failure.status,
                        headers: { get: () => failure.retryAfter || null },
                        json: async () => failure.body,
                    };
                return { ok: true, json: async () => ({}) };
            },
        });
        vm.runInContext(
            `${proxySource}\nconst proxy = { startUpload, putPart, finishUpload, cancelUpload, getMessages, readFile, thumb, deleteMessages };\n${clientSource}\nglobalThis.create = createProxyClient;`,
            context,
        );
        const file = new Blob([Buffer.alloc(33 * 524288)]);
        file.name = "x";
        const upload = context
            .create()
            .proxyUpload(file, { signal: controller.signal });
        if (abort) await assert.rejects(upload, { name: "AbortError" });
        else await upload;
        return {
            calls: calls.filter((c) =>
                /\/(?:tgxd\/u|upload\/u)\/\d+$/.test(c.url),
            ),
            events,
            waits,
            leases,
        };
    }
    let result = await run();
    assert.ok(
        result.calls.every((c) =>
            c.url.startsWith("https://up.example/api/tgxd/"),
        ),
    );
    assert.equal(result.calls[0].options.credentials, "omit");
    assert.equal(result.calls[0].options.headers["X-Upload-Key"], "secret");
    for (const settings of [{ key: null }, { origin: "" }]) {
        result = await run(settings);
        assert.ok(result.calls.every((c) => c.url.startsWith("/api/tgx/")));
    }
    result = await run({ failures: ["network"] });
    assert.ok(result.calls.some((c) => c.url === "/api/tgx/upload/u/0"));
    assert.ok(result.calls.some((c) => c.url === "/api/tgx/upload/u/32"));
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0][0], "upload.direct.fallback");
    assert.deepEqual(
        sanitizeDiag({
            evt: result.events[0][0],
            key: "secret",
            url: "https://up.example",
        }),
        {
            event: { evt: "upload.direct.fallback" },
            dropped: 2,
        },
    );
    result = await run({
        failures: [
            {
                status: 429,
                retryAfter: "4",
                body: { error: "busy", seconds: 5 },
            },
            { status: 409, body: { error: "lease_required" } },
        ],
    });
    assert.ok(
        result.calls.every((c) => c.url.startsWith("https://up.example/")),
    );
    assert.ok(result.waits.includes(5000));
    assert.equal(result.leases, 1);
    assert.equal(result.events.length, 0);
    result = await run({ abort: true });
    assert.equal(result.calls.length, 1);
    assert.equal(result.events.length, 0);
});

test("non-admin installs proxy only after lease and stops it on lease loss", async () => {
    const source = await readFile(
        new URL("../../src/services/account.js", import.meta.url),
        "utf8",
    );
    const flow = source
        .slice(
            source.indexOf("async function enter(key)"),
            source.indexOf("async function connectTelegram()"),
        )
        .replace("export async function", "async function");
    const connect =
        source.slice(
            source.indexOf("async function connectTelegram()"),
            source.indexOf(
                "        const { session } = await api.getSession();",
            ),
        ) + "throw new Error('admin path'); } catch (error) { throw error; } }";
    const calls = [];
    const events = [];
    let clock = 0;
    let poll,
        heartbeat,
        status = "busy";
    const context = vm.createContext({
        account: { admin: false, username: "user" },
        dek: null,
        leasePoll: null,
        heartbeat: null,
        leaseGrantedAt: 0,
        HEARTBEAT: 10000,
        LEASE_GRACE: 22000,
        Date: class extends Date {
            static now() {
                return clock;
            }
        },
        document: { visibilityState: "hidden" },
        diag: (event, fields) => events.push({ event, ...fields }),
        set: (state) => calls.push(state.phase),
        openDrive: async () => calls.push("drive"),
        openUploadLog() {},
        migrateLegacyTree: async () => {},
        refresh: async () => {},
        createProxyClient: () => "proxy",
        setClient: (c) => calls.push(c),
        stopClient: async () => calls.push("stopped"),
        connection() {},
        api: {
            lease: async () => {
                calls.push("lease");
                return { status };
            },
            getSession: () => {
                throw new Error("getSession called");
            },
            release: async () => calls.push("release"),
        },
        browserId: () => "browser",
        describeError: String,
        swallow: () => () => {},
        setInterval: (fn, ms) => {
            if (ms === 10000) heartbeat = fn;
            else poll = fn;
            return 1;
        },
        clearInterval() {},
    });
    vm.runInContext(
        `${flow}\r\n${connect}\r\nglobalThis.enter = enter;`,
        context,
    );
    await context.enter("key");
    assert.deepEqual(calls, ["connecting", "drive", "lease", "lease"]);
    status = "granted";
    await poll();
    assert.deepEqual(calls.slice(-4), [
        "lease",
        "connecting",
        "proxy",
        "ready",
    ]);
    status = "revoked";
    clock = 16001;
    await heartbeat();
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "conn.heartbeatGap");
    assert.equal(events[0].ms, 16001);
    assert.equal(events[0].visibility, "hidden");
    assert.deepEqual(calls.slice(-4), ["lease", "stopped", "release", "lease"]);
});

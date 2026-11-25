import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { Api } from "telegram";
import { Buffer } from "buffer";

test("proxy upload, range, thumbnail and deletion use owned HTTP routes", async () => {
    const calls = [];
    const parts = [];
    let active = 0,
        maxActive = 0,
        retried = false;
    let hold = false;
    let stored;
    const fetch = async (url, options) => {
        calls.push(url);
        let result = {};
        if (url.endsWith("/upload/start")) result = { uploadId: "u" };
        else if (/\/upload\/u\/\d+$/.test(url)) {
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
            stored = Buffer.concat(parts);
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
        .replace('import { ApiError } from "./api";', "")
        .replaceAll("export const ", "const ");
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
        constructor(status, message) {
            super(message);
            this.status = status;
        }
    }
    const context = vm.createContext({
        Api,
        Buffer,
        Uint8Array,
        fetch,
        ApiError,
        setTimeout,
        clearTimeout,
    });
    vm.runInContext(
        `${proxySource}\nconst proxy = { startUpload, putPart, finishUpload, cancelUpload, getMessages, readFile, thumb, deleteMessages };\n${clientSource}\nglobalThis.create = createProxyClient;`,
        context,
    );
    const client = context.create();
    const bytes = Buffer.alloc(2200000, 123);
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
    assert.equal(parts.length, 5);
    assert.equal(maxActive, 4);
    assert.equal(stats.bytes, bytes.length);
    assert.equal(stats.parts, 5);
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
    vm.runInContext(`${flow}\n${connect}\nglobalThis.enter = enter;`, context);
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
    await heartbeat();
    assert.deepEqual(calls.slice(-4), ["lease", "stopped", "release", "lease"]);
});

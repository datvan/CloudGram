import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
});
const data = (s) =>
    `data:text/javascript;base64,${Buffer.from(s).toString("base64")}`;
const root = new URL("../../src/services/", import.meta.url);
const cryptoUrl = data(await readFile(new URL("crypto.js", root), "utf8"));
const apiUrl = data(await readFile(new URL("api.js", root), "utf8"));
const source = (await readFile(new URL("thumbStore.js", root), "utf8"))
    .replace('"./crypto"', JSON.stringify(cryptoUrl))
    .replace('"./api"', JSON.stringify(apiUrl));
const store = await import(data(source));
const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
);
const bytes = new Uint8Array([1, 2, 3]);
const blob = await store.encryptThumb(key, "a", bytes);
const calls = [];
let handler = () => ({ thumbs: {} });
globalThis.fetch = async (path, options) => {
    const call = { path, ...JSON.parse(options.body) };
    calls.push(call);
    return { ok: true, json: async () => handler(call) };
};
const originalUrl = globalThis.URL;
let next = 0;
const revoked = [];
globalThis.URL = {
    createObjectURL: () => `blob:${++next}`,
    revokeObjectURL: (url) => revoked.push(url),
};
test.after(() => {
    globalThis.URL = originalUrl;
});

test("encryption round trip, ref binding and inline precedence", async () => {
    assert.match(store.newThumbRef(), /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(await store.decryptThumb(key, "a", blob), bytes);
    assert.equal(await store.decryptThumb(key, "b", blob), null);
    assert.equal(
        await store.thumbUrl({
            thumbData: "data:first",
            thumbnail: "data:second",
            thumbRef: "a",
        }),
        "data:first",
    );
    assert.equal(
        await store.thumbUrl({ thumbnail: "data:legacy" }),
        "data:legacy",
    );
});

test("batching, deduplication, pagination and negative cache", async () => {
    store.setThumbKey(key);
    calls.length = 0;
    const b = await store.encryptThumb(key, "b", bytes);
    handler = ({ ids }) =>
        ids.includes("a")
            ? { thumbs: { a: blob }, more: true }
            : { thumbs: { b } };
    const a = store.thumbUrl({ thumbRef: "a" });
    assert.equal(a, store.thumbUrl({ thumbRef: "a" }));
    const results = await Promise.all([
        a,
        store.thumbUrl({ thumbRef: "b" }),
        store.thumbUrl({ thumbRef: "missing" }),
    ]);
    assert.deepEqual(results, ["blob:1", "blob:2", null]);
    assert.deepEqual(
        calls.map((c) => c.ids),
        [
            ["a", "b", "missing"],
            ["b", "missing"],
        ],
    );
    assert.equal(await store.thumbUrl({ thumbRef: "missing" }), null);
    assert.equal(calls.length, 2);
});

test("LRU evicts and revokes, close clears cache", async () => {
    store.setThumbKey(key);
    calls.length = 0;
    const blobs = {};
    for (let i = 0; i < 501; i++)
        blobs[i] = await store.encryptThumb(key, String(i), bytes);
    handler = ({ ids }) => ({
        thumbs: Object.fromEntries(ids.map((id) => [id, blobs[id]])),
    });
    await Promise.all(
        Array.from({ length: 500 }, (_, i) =>
            store.thumbUrl({ thumbRef: String(i) }),
        ),
    );
    assert.equal(calls.length, 3);
    const first = await store.thumbUrl({ thumbRef: "0" });
    const before = revoked.length;
    await store.thumbUrl({ thumbRef: "501missing" });
    // A missing server record is not a cache entry.
    handler = () => ({ thumbs: { 500: blobs[500] } });
    await store.thumbUrl({ thumbRef: "500" });
    assert.equal(revoked.length, before + 1);
    assert.ok(!revoked.includes(first));
    store.setThumbKey(null);
    assert.ok(revoked.includes(first));
});

test("closing drive discards an in-flight response", async () => {
    store.setThumbKey(key);
    let release;
    const received = new Promise((resolve) => {
        release = resolve;
    });
    let started;
    const requestStarted = new Promise((resolve) => {
        started = resolve;
    });
    handler = () => {
        started();
        return received;
    };
    const pending = store.thumbUrl({ thumbRef: "a" });
    await requestStarted;
    store.setThumbKey(null);
    assert.equal(await pending, null);
    release({ thumbs: { a: blob } });
    store.setThumbKey(key);
    handler = () => ({ thumbs: {} });
    assert.equal(await store.thumbUrl({ thumbRef: "a" }), null);
});

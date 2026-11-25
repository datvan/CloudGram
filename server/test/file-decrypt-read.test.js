import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as cryptoFile from "../../src/services/fileCrypto.js";

test("encrypted range crosses chunks, reads last chunk, and rejects tampering", async () => {
    const { CHUNK, newFileKey, importFileKey, encryptChunk } = cryptoFile;
    const plain = Uint8Array.from({ length: CHUNK + 31 }, (_, i) => i % 251);
    const enc = { ...newFileKey(), size: plain.length };
    const key = await importFileKey(enc);
    const first = await encryptChunk(
        key,
        enc,
        0,
        plain.subarray(0, CHUNK),
        false,
    );
    const last = await encryptChunk(key, enc, 1, plain.subarray(CHUNK), true);
    const cipher = new Uint8Array(first.length + last.length);
    cipher.set(first);
    cipher.set(last, first.length);
    const source = await readFile(
        new URL("../../src/utils/transfer.js", import.meta.url),
        "utf8",
    );
    const body = source.slice(
        source.indexOf("export async function encryptedRange"),
        source.indexOf("export async function filePart"),
    );
    const read = vm.runInNewContext(
        `(${body.replace(
            "export async function encryptedRange",
            "async function encryptedRange",
        )})`,
        {
            ...cryptoFile,
            decryptFileChunk: cryptoFile.decryptChunk,
            Uint8Array,
            Math,
            MB: 1024 * 1024,
            filePart: async (_client, _file, index, size) =>
                cipher.slice(index * size, (index + 1) * size),
        },
    );
    assert.deepEqual(
        await read(null, { size: cipher.length }, enc, CHUNK - 8, CHUNK + 12),
        plain.slice(CHUNK - 8, CHUNK + 13),
    );
    assert.deepEqual(
        await read(
            null,
            { size: cipher.length },
            enc,
            CHUNK + 20,
            plain.length - 1,
        ),
        plain.slice(CHUNK + 20),
    );
    cipher[CHUNK + 20] ^= 1;
    await assert.rejects(
        read(null, { size: cipher.length }, enc, CHUNK, plain.length - 1),
    );
});

test("empty file has one authenticated chunk", async () => {
    const enc = { ...cryptoFile.newFileKey(), size: 0 };
    const key = await cryptoFile.importFileKey(enc);
    const cipher = await cryptoFile.encryptChunk(
        key,
        enc,
        0,
        new Uint8Array(),
        true,
    );
    assert.equal(cryptoFile.chunkCount(0), 1);
    assert.equal(cryptoFile.encryptedSize(0), 16);
    assert.equal(cipher.length, 16);
    assert.equal(
        (await cryptoFile.decryptChunk(key, enc, 0, cipher, true)).length,
        0,
    );
    const source = await readFile(
        new URL("../../src/utils/transfer.js", import.meta.url),
        "utf8",
    );
    const body = source.slice(
        source.indexOf("export async function encryptedRange"),
        source.indexOf("export async function filePart"),
    );
    const read = vm.runInNewContext(
        `(${body.replace(
            "export async function encryptedRange",
            "async function encryptedRange",
        )})`,
        {
            ...cryptoFile,
            decryptFileChunk: cryptoFile.decryptChunk,
            Uint8Array,
            Math,
            MB: 1024 * 1024,
            filePart: async () => cipher,
        },
    );
    assert.equal((await read(null, { size: 16 }, enc, 0, -1)).length, 0);
    cipher[0] ^= 1;
    await assert.rejects(read(null, { size: 16 }, enc, 0, -1));
});

test("file worker decrypts and falls back inline when unavailable", async () => {
    const source = await readFile(
        new URL("../../src/services/decryptWorkers.js", import.meta.url),
        "utf8",
    );
    const body = source
        .slice(
            source.indexOf("function fileWorkerMain"),
            source.indexOf("// the GramJS"),
        )
        .replace(
            "export async function decryptFileChunk",
            "async function decryptFileChunk",
        );
    let handler;
    let active;
    const self = {
        addEventListener: (_type, fn) => {
            handler = fn;
        },
        postMessage: (data) => active.onmessage({ data }),
    };
    class FakeWorker {
        constructor() {
            active = this;
        }
        postMessage(data) {
            handler({ data });
        }
        terminate() {}
    }
    const context = {
        self,
        crypto,
        atob,
        Uint8Array,
        DataView,
        BigInt,
        TextEncoder,
        Blob,
        URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
        Worker: FakeWorker,
        decryptChunk: cryptoFile.decryptChunk,
        setTimeout,
        clearTimeout,
        WORKER_TIMEOUT: 1000,
    };
    const worker = vm.runInNewContext(
        `${body}\nfileWorkerMain(); decryptFileChunk`,
        context,
    );
    const enc = { ...cryptoFile.newFileKey(), size: 3 };
    const key = await cryptoFile.importFileKey(enc);
    const plain = Uint8Array.of(4, 5, 6);
    const cipher = await cryptoFile.encryptChunk(key, enc, 0, plain, true);
    assert.deepEqual(await worker(key, enc, 0, cipher, true), plain);
    cipher[0] ^= 1;
    await assert.rejects(worker(key, enc, 0, cipher, true));
    cipher[0] ^= 1;
    const fallback = vm.runInNewContext(`${body}\ndecryptFileChunk`, {
        ...context,
        Worker: undefined,
    });
    assert.deepEqual(await fallback(key, enc, 0, cipher, true), plain);
});

test("legacy record downloads unchanged", async () => {
    const source = await readFile(
        new URL("../../src/utils/downloadFile.js", import.meta.url),
        "utf8",
    );
    const body = source.slice(
        source.indexOf("export async function fetchFile"),
        source.indexOf("/**\n * A file sent as several"),
    );
    const original = Uint8Array.of(1, 2, 3, 4);
    const file = {
        size: original.length,
        mimeType: "application/octet-stream",
    };
    const client = { getMessages: async () => [{ media: {} }] };
    const fetch = vm.runInNewContext(
        `(${body.replace(
            "export async function fetchFile",
            "async function fetchFile",
        )})`,
        {
            Store: { dispatch() {} },
            getRecord: () => ({ file_id: 7 }),
            messagesOf: () => [7],
            getClient: () => client,
            locate: () => file,
            downloadParts: async () => original,
            downloadProgress: () => ({}),
            completedProgress: () => ({}),
            errorProgress: () => ({}),
            Blob,
            Math,
            TO_DISK: 64 * 1024 * 1024,
            console,
        },
    );
    const result = await fetch("record", 7);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), original);
});

test("stream joins split records using each part's own key", async () => {
    const source = await readFile(
        new URL("../../src/services/stream.js", import.meta.url),
        "utf8",
    );
    const body = source.slice(
        source.indexOf("async function fetchPart"),
        source.indexOf("function trim"),
    );
    const pieces = [
        { start: 0, size: 3, enc: { key: "first" } },
        { start: 3, size: 4, enc: { key: "second" } },
    ];
    const seen = [];
    const fetch = vm.runInNewContext(`(${body})`, {
        info: async () => ({ size: 7, pieces }),
        getClient: () => ({}),
        PART: 1024 * 1024,
        Uint8Array,
        Math,
        encryptedRange: async (_client, _piece, enc, start, end) => {
            seen.push(enc.key);
            return new Uint8Array(end - start + 1).fill(
                enc.key === "first" ? 1 : 2,
            );
        },
    });
    assert.deepEqual(await fetch(7, 0), Uint8Array.of(1, 1, 1, 2, 2, 2, 2));
    assert.deepEqual(seen, ["first", "second"]);
});

test("share re-encrypts plaintext with share key", async () => {
    const source = await readFile(
        new URL("../../src/services/shares.js", import.meta.url),
        "utf8",
    );
    const shareCrypto = await import("../../src/services/shareCrypto.js");
    const plain = Uint8Array.of(9, 8, 7);
    let uploaded;
    const context = {
        ...shareCrypto,
        Blob,
        Uint8Array,
        Math,
        Promise,
        fetchFile: async () => new Blob([plain]),
        api: {
            createShare: async () => ({
                id: "share",
                chunkSize: 32,
                chunks: 1,
            }),
            completeShare: async () => ({}),
        },
        putShareChunk: async (_id, _index, bytes) => {
            uploaded = bytes;
        },
        getRecord: () => ({}),
        update() {},
        flush: async () => {},
    };
    const body = source
        .replace(/^import .*;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const create = vm.runInNewContext(`${body}\ncreateShare`, context);
    const share = await create(
        { id: "record", file_id: 1, name: "file" },
        null,
    );
    const key = await shareCrypto.importShareKey(share.secret);
    assert.deepEqual(await shareCrypto.decryptChunk(key, 0, uploaded), plain);
});

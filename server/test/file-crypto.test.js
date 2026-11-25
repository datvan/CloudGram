import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as fileCrypto from "../../src/services/fileCrypto.js";
import {
    CHUNK,
    ENC_CHUNK,
    chunkCount,
    decryptChunk,
    encryptChunk,
    encryptedSize,
    importFileKey,
    newFileKey,
    plainRangeToCipher,
} from "../../src/services/fileCrypto.js";

test("file chunks authenticate content, index and final status", async () => {
    const enc = { ...newFileKey(), size: CHUNK + 3 };
    const key = await importFileKey(enc);
    const first = new Uint8Array(CHUNK).fill(7);
    const last = new Uint8Array([1, 2, 3]);
    const a = await encryptChunk(key, enc, 0, first, false);
    const b = await encryptChunk(key, enc, 1, last, true);
    assert.deepEqual(await decryptChunk(key, enc, 0, a, false), first);
    assert.deepEqual(await decryptChunk(key, enc, 1, b, true), last);
    const tampered = a.slice();
    tampered[0] ^= 1;
    await assert.rejects(decryptChunk(key, enc, 0, tampered, false));
    await assert.rejects(decryptChunk(key, enc, 0, a.subarray(0, -1), false));
    await assert.rejects(decryptChunk(key, enc, 1, a, false));
    await assert.rejects(decryptChunk(key, enc, 0, a, true));
});

test("sizes and inclusive ranges map to encrypted chunks", () => {
    assert.equal(chunkCount(0), 1);
    assert.equal(encryptedSize(0), 16);
    assert.equal(encryptedSize(CHUNK), ENC_CHUNK);
    assert.equal(encryptedSize(CHUNK + 3), ENC_CHUNK + 19);
    assert.deepEqual(
        plainRangeToCipher({ size: CHUNK + 3 }, CHUNK - 1, CHUNK),
        {
            firstChunk: 0,
            lastChunk: 1,
            cipherStart: 0,
            cipherEnd: ENC_CHUNK + 18,
        },
    );
});

test("upload source streams encrypted bytes and reuses the same key on resume", async () => {
    const source = (
        await readFile(
            new URL("../../src/utils/uploadFile.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport default /g, "")
        .replace(/\bexport /g, "");
    const { encryptedSource } = vm.runInNewContext(
        `${source}\n;({ encryptedSource })`,
        {
            ...fileCrypto,
            turns: () => ({}),
            Uint8Array,
            crypto,
        },
    );
    const bytes = new Uint8Array(CHUNK + 37).map((_, i) => i % 251);
    const file = new Blob([bytes]);
    const enc = { ...newFileKey(), size: file.size };
    const wrapped = await encryptedSource(file, enc, "cg-0000000000000000.bin");
    const resumed = await encryptedSource(file, enc, wrapped.name);
    assert.equal(wrapped.size, encryptedSize(file.size));
    const parts = [];
    for (let start = 0; start < wrapped.size; start += CHUNK) {
        const end = Math.min(start + CHUNK, wrapped.size);
        const part = new Uint8Array(
            await wrapped.slice(start, end).arrayBuffer(),
        );
        assert.deepEqual(
            part,
            new Uint8Array(await resumed.slice(start, end).arrayBuffer()),
        );
        parts.push(part);
    }
    const ciphertext = new Uint8Array(await new Blob(parts).arrayBuffer());
    const key = await importFileKey(enc);
    assert.deepEqual(
        await decryptChunk(
            key,
            enc,
            0,
            ciphertext.subarray(0, ENC_CHUNK),
            false,
        ),
        bytes.subarray(0, CHUNK),
    );
    assert.deepEqual(
        await decryptChunk(key, enc, 1, ciphertext.subarray(ENC_CHUNK), true),
        bytes.subarray(CHUNK),
    );
});

test("encrypted upload sends opaque document and saves its key before upload", async () => {
    const source = (
        await readFile(
            new URL("../../src/utils/uploadFile.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport default /g, "")
        .replace(/\bexport /g, "");
    const events = [];
    let options;
    const client = {
        sendFile: async (peer, value) => {
            assert.equal(peer, "me");
            options = value;
            return { id: 7 };
        },
    };
    const { uploadFile } = vm.runInNewContext(`${source}\n;({ uploadFile })`, {
        ...fileCrypto,
        crypto,
        Uint8Array,
        performance,
        setTimeout,
        clearTimeout,
        FILE_ENCRYPTION: true,
        SPLIT_RAW: true,
        encryptedThumb: async () => undefined,
        sliceLimit: () => Infinity,
        splitSizes: (size) => [size],
        turns: () => ({ take: async () => {}, give: () => {} }),
        uploadParts: async (_client, input) => {
            events.push("upload");
            assert.match(input.name, /^cg-[a-f0-9]{16}\.bin$/);
            assert.equal(input.size, encryptedSize(3));
            return { name: input.name };
        },
        Store: { dispatch() {} },
        uploadProgress: () => ({}),
        errors: { RPCError: class extends Error {} },
    });
    const resume = {};
    const result = await uploadFile(
        "id",
        new Blob([new Uint8Array([1, 2, 3])]),
        {
            client,
            resume,
            onEncryption: async () => {
                events.push("saved");
            },
        },
    );
    assert.deepEqual(events, ["saved", "upload"]);
    assert.equal(result.changes.enc, resume.enc);
    assert.equal(options.forceDocument, true);
    assert.deepEqual(Object.keys(options).sort(), ["file", "forceDocument"]);
});

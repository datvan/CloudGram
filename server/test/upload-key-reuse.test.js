import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import vm from "node:vm";

async function setup(limit = Infinity, thumb = null, ref = null) {
    const source = (
        await readFile(
            new URL("../../src/utils/uploadFile.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport default /g, "")
        .replace(/\bexport /g, "");
    let serial = 0;
    const deleted = [];
    const uploads = [];
    const client = {
        deleteMessages: async (_peer, ids) => deleted.push(...ids),
        getMessages: async () => [],
        sendFile: async () => ({ id: ++serial }),
    };
    const { uploadFile } = vm.runInNewContext(`${source}\n;({ uploadFile })`, {
        crypto,
        Uint8Array,
        performance,
        setTimeout,
        clearTimeout,
        File,
        CHUNK: 512 * 1024,
        ENC_CHUNK: 512 * 1024 + 16,
        chunkCount: (size) => Math.max(1, Math.ceil(size / (512 * 1024))),
        encryptedSize: (size) =>
            size + 16 * Math.max(1, Math.ceil(size / (512 * 1024))),
        newFileKey: () => ({ key: `key-${++serial}` }),
        importFileKey: async () => ({}),
        FILE_ENCRYPTION: true,
        SPLIT_RAW: true,
        encryptedThumb: async () => thumb,
        storeThumb: async () => ref,
        thumbFail() {},
        sliceLimit: () => limit,
        splitSizes: (size, max) => (size > max ? [max, size - max] : [size]),
        pieceName: (name, i) => `${name}.${i}`,
        turns: () => ({ take: async () => {}, give() {} }),
        uploadParts: async (_client, _input, { resume }) => {
            uploads.push({
                key: resume.enc.key,
                fileId: resume.fileId,
                done: resume.done,
            });
            return {};
        },
        Store: { dispatch() {} },
        uploadProgress: () => ({}),
        errors: { RPCError: class extends Error {} },
    });
    return { uploadFile, client, deleted, uploads };
}

test("upload stores a reference or falls back to inline thumbnail", async () => {
    for (const ref of ["ref-1", null]) {
        const { uploadFile, client } = await setup(
            Infinity,
            "data:image/jpeg;base64,AQID",
            ref,
        );
        const resume = {};
        const result = await uploadFile("id", new File(["abc"], "a"), {
            client,
            resume,
        });
        if (ref) {
            assert.equal(result.changes.thumbRef, ref);
            assert.equal("thumbData" in result.changes, false);
            assert.equal(resume.thumbRef, ref);
        } else
            assert.equal(
                result.changes.thumbData,
                "data:image/jpeg;base64,AQID",
            );
    }
});

test("resume regenerates a null encrypted thumbnail", async () => {
    const { uploadFile, client } = await setup(
        Infinity,
        "data:image/jpeg;base64,AQID",
        "ref-1",
    );
    const resume = { thumbData: null };
    const result = await uploadFile("id", new File(["abc"], "a"), {
        client,
        resume,
    });
    assert.equal(result.changes.thumbRef, "ref-1");
});

test("fingerprint match resumes; changed or missing fingerprint starts fresh", async () => {
    const { uploadFile, client, uploads } = await setup();
    const file = new File(["abc"], "a");
    const resume = {};
    await uploadFile("id", file, { client, resume });
    const original = resume.enc.key;
    resume.fileId = 42;
    await uploadFile("id", file, { client, resume });
    assert.equal(resume.enc.key, original);
    assert.equal(uploads.at(-1).fileId, 42);
    await uploadFile("id", new File(["abd"], "a"), { client, resume });
    assert.notEqual(resume.enc.key, original);
    assert.equal(uploads.at(-1).fileId, undefined);
    const changed = resume.enc.key;
    delete resume.enc.fingerprint;
    await uploadFile("id", file, { client, resume });
    assert.notEqual(resume.enc.key, changed);
});

test("missing split part clears in-flight key and progress", async () => {
    const { uploadFile, client, uploads } = await setup(512 * 1024 + 16);
    const file = new File([new Uint8Array(1024 * 1024)], "a");
    const resume = {};
    await uploadFile("id", file, { client, resume });
    const old = resume.pieces[1].enc;
    resume.pieces.length = 1;
    resume.enc = old;
    resume.name = "old";
    resume.fileId = 42;
    resume.done = new Set([0]);
    resume.verify = true;
    uploads.length = 0;
    await uploadFile("id", file, { client, resume });
    assert.notEqual(uploads[0].key, old.key);
    assert.equal(uploads[0].fileId, undefined);
    assert.equal(uploads[0].done, undefined);
});

test("changed split file deletes sent pieces and starts with a fresh key", async () => {
    const { uploadFile, client, uploads, deleted } = await setup(
        512 * 1024 + 16,
    );
    const resume = {};
    await uploadFile("id", new File([new Uint8Array(1024 * 1024)], "a"), {
        client,
        resume,
    });
    const ids = Array.from(resume.pieces, (piece) => piece.id);
    const old = resume.pieces[0].enc.key;
    const bytes = new Uint8Array(1024 * 1024);
    bytes[100] = 1;
    uploads.length = 0;
    await uploadFile("id", new File([bytes], "a"), { client, resume });
    assert.deepEqual(deleted, ids);
    assert.notEqual(uploads[0].key, old);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
    encryptPreview,
    decryptPreview,
} from "../../src/services/previewCrypto.js";

const limit = 8 * 1024 * 1024;
const blob = (bytes) => new Blob([bytes]);

test("round trips both purposes with fresh keys and nonces", async () => {
    for (const purpose of ["thumbnail", "storyboard"]) {
        const first = await encryptPreview(blob("preview"), purpose);
        const second = await encryptPreview(blob("preview"), purpose);
        assert.equal(first.ciphertext.type, "application/octet-stream");
        assert.equal(first.metadata.v, 1);
        assert.notEqual(first.metadata.key, second.metadata.key);
        assert.notEqual(first.metadata.nonce, second.metadata.nonce);
        const result = await decryptPreview(
            first.ciphertext,
            first.metadata,
            purpose,
        );
        assert.equal(result.type, "image/jpeg");
        assert.equal(await result.text(), "preview");
    }
});

test("rejects wrong purpose and modified or truncated ciphertext", async () => {
    const { ciphertext, metadata } = await encryptPreview(
        blob("preview"),
        "thumbnail",
    );
    await assert.rejects(decryptPreview(ciphertext, metadata, "storyboard"));
    await assert.rejects(encryptPreview(blob("x"), "other"));
    await assert.rejects(decryptPreview(ciphertext, metadata, "other"));
    const bytes = new Uint8Array(await ciphertext.arrayBuffer());
    bytes[0] ^= 1;
    await assert.rejects(decryptPreview(blob(bytes), metadata, "thumbnail"));
    await assert.rejects(
        decryptPreview(ciphertext.slice(0, -1), metadata, "thumbnail"),
    );
    await assert.rejects(
        decryptPreview(blob(new Uint8Array(15)), metadata, "thumbnail"),
    );
});

test("rejects invalid metadata", async () => {
    const { ciphertext, metadata } = await encryptPreview(
        blob("x"),
        "thumbnail",
    );
    for (const changes of [
        { v: 2 },
        { key: "!invalid!" },
        { nonce: "!invalid!" },
        { key: btoa("short") },
        { nonce: btoa("short") },
        { key: metadata.key.replace(/=$/, "") },
        { nonce: metadata.nonce + "=" },
    ]) {
        await assert.rejects(
            decryptPreview(
                ciphertext,
                { ...metadata, ...changes },
                "thumbnail",
            ),
        );
    }
    await assert.rejects(decryptPreview(ciphertext, null, "thumbnail"));
});

test("enforces plaintext and ciphertext size limits", async () => {
    const { ciphertext, metadata } = await encryptPreview(
        blob(new Uint8Array(limit)),
        "thumbnail",
    );
    assert.equal(ciphertext.size, limit + 16);
    assert.equal(
        (await decryptPreview(ciphertext, metadata, "thumbnail")).size,
        limit,
    );
    await assert.rejects(
        encryptPreview(blob(new Uint8Array(limit + 1)), "thumbnail"),
    );
    await assert.rejects(
        decryptPreview(blob(new Uint8Array(limit + 17)), metadata, "thumbnail"),
    );
});

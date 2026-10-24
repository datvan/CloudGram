/**
 * The streaming ZIP reader behind the Dropbox import, fed the kind of ZIP
 * Dropbox builds: stored entries whose sizes come after the data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ZipReader } from "../../src/services/zipStream.js";

const enc = new TextEncoder();

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) {
        c ^= b;
        for (let k = 0; k < 8; k += 1)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
}

function le(n, bytes) {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 1) out[i] = Math.floor(n / 256 ** i) % 256;
    return out;
}

const join = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};

/** A ZIP as Dropbox streams it; `sized` entries carry sizes up front. */
function buildZip(entries, { method = 0, badCrc = false } = {}) {
    const parts = [];
    for (const { name, data = new Uint8Array(0), sized = false } of entries) {
        const nameBytes = enc.encode(name);
        const crc = crc32(data);
        parts.push(
            le(0x04034b50, 4),
            le(20, 2),
            le(sized ? 0 : 8, 2),
            le(method, 2),
            le(0, 4),
            le(sized ? crc : 0, 4),
            le(sized ? data.length : 0, 4),
            le(sized ? data.length : 0, 4),
            le(nameBytes.length, 2),
            le(0, 2),
            nameBytes,
            data,
        );
        if (!sized) {
            parts.push(
                le(0x08074b50, 4),
                le(badCrc ? crc ^ 1 : crc, 4),
                le(data.length, 4),
                le(data.length, 4),
            );
        }
    }
    // a central directory start is all the reader needs to see to stop
    parts.push(le(0x02014b50, 4), new Uint8Array(40));
    return join(parts);
}

function read(zip, chunkSize) {
    const out = [];
    let current;
    const reader = new ZipReader({
        onEntry: (e) => {
            current = { ...e, parts: [] };
        },
        onData: (bytes) => current.parts.push(bytes.slice()),
        onEntryEnd: ({ size }) => {
            const data = join(current.parts);
            assert.equal(size, data.length);
            out.push({ path: current.path, dir: current.dir, data });
        },
    });
    for (let at = 0; at < zip.length; ) {
        const n =
            typeof chunkSize === "function" ? chunkSize() : chunkSize ?? 1;
        reader.push(zip.slice(at, at + n));
        at += n;
    }
    reader.end();
    return out;
}

// content that contains a descriptor signature, and even a whole fake
// descriptor followed by a local header, which must not end the entry
const tricky = join([
    enc.encode("before PK\x07\x08 after"),
    le(0x08074b50, 4),
    le(0, 4),
    le(5, 4),
    le(5, 4),
    le(0x04034b50, 4),
    new Uint8Array(1000).map((_, i) => (i * 7) % 256),
    enc.encode("PK\x07"),
]);

const entries = [
    { name: "/" },
    { name: "Ảnh ⭐/" },
    { name: "Ảnh ⭐/tricky.bin", data: tricky },
    { name: "Ảnh ⭐/empty.txt" },
    { name: "Trống/" },
    { name: "known.txt", data: enc.encode("sizes up front"), sized: true },
    { name: "last.bin", data: new Uint8Array(70_000).fill(0x50) },
];

test("reads every entry whatever the chunking", () => {
    const zip = buildZip(entries);
    let seed = 7;
    const random = () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return 1 + (seed % 97);
    };
    for (const chunking of [1, 2, 3, 5, 16, 17, 4096, zip.length, random]) {
        const got = read(zip, chunking);
        assert.deepEqual(
            got.map((e) => [e.path, e.dir, e.data.length]),
            [
                ["", true, 0],
                ["Ảnh ⭐/", true, 0],
                ["Ảnh ⭐/tricky.bin", false, tricky.length],
                ["Ảnh ⭐/empty.txt", false, 0],
                ["Trống/", true, 0],
                ["known.txt", false, 14],
                ["last.bin", false, 70_000],
            ],
            `chunk size ${chunking}`,
        );
        assert.deepEqual(got[2].data, tricky);
    }
});

test("rejects damage instead of guessing", () => {
    const zip = buildZip(entries);
    assert.throws(() => read(zip.subarray(0, zip.length - 60), 100), {
        code: "zip_truncated",
    });
    assert.throws(() => read(buildZip(entries, { badCrc: true }), 64), {
        code: "zip_crc",
    });
    assert.throws(
        () =>
            read(
                buildZip([{ name: "a.txt", data: enc.encode("x") }], {
                    method: 8,
                }),
                64,
            ),
        { code: "zip_compressed" },
    );
    assert.throws(() => read(enc.encode("<html>nope</html>"), 64), {
        code: "zip_corrupt",
    });
});

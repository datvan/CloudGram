/** Telegram's file size limit and the command that cuts a bigger file. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    FREE_MAX,
    PREMIUM_MAX,
    maxFileBytes,
    pieceBytes,
    pieceCount,
    splitCommand,
} from "../../src/utils/splitPlan.js";

const MiB = 1024 * 1024;

test("the limits are 4000 and 8000 parts of 512 KiB", () => {
    assert.equal(FREE_MAX, 2000 * MiB);
    assert.equal(PREMIUM_MAX, 4000 * MiB);
});

test("only a known free account gets the smaller limit", () => {
    assert.equal(maxFileBytes(false), FREE_MAX);
    assert.equal(maxFileBytes(true), PREMIUM_MAX);
    assert.equal(maxFileBytes(undefined), PREMIUM_MAX);
});

test("a piece stays under the limit and is whole MiB", () => {
    for (const limit of [FREE_MAX, PREMIUM_MAX]) {
        const piece = pieceBytes(limit);
        assert.ok(piece < limit);
        assert.equal(piece % MiB, 0);
    }
});

test("pieceCount rounds up and covers the file", () => {
    const piece = pieceBytes(PREMIUM_MAX);
    assert.equal(pieceCount(piece, PREMIUM_MAX), 1);
    assert.equal(pieceCount(piece + 1, PREMIUM_MAX), 2);
    assert.equal(pieceCount(5 * piece, PREMIUM_MAX), 5);
});

test("a video is cut by ffmpeg, a piece's seconds from its share of the file", () => {
    const piece = pieceBytes(PREMIUM_MAX);
    const size = 3 * piece;
    const command = splitCommand("Phim 100%.mkv", size, PREMIUM_MAX, 9000);
    assert.match(command, /^ffmpeg -i "Phim 100%\.mkv" /);
    assert.match(command, /-c copy/);
    assert.match(command, /-segment_time 3000 /);
    assert.match(command, /"Phim 100%%\.part%03d\.mp4"$/);
});

test("without a duration the command keeps a placeholder", () => {
    const command = splitCommand("a.mp4", 5e9, PREMIUM_MAX);
    assert.match(command, /-segment_time <số giây> /);
});

test("anything else goes into 7-Zip volumes under the limit", () => {
    const command = splitCommand("data.zip", 6e9, FREE_MAX);
    assert.equal(command, '7z a -v1700m "data.zip.7z" "data.zip"');
});

import {
    messagesOf,
    pieceName,
    sliceMax,
    splitSizes,
} from "../../src/utils/splitPlan.js";

test("a file within the limit is one slice", () => {
    assert.deepEqual(splitSizes(5, FREE_MAX), [5]);
    assert.deepEqual(splitSizes(FREE_MAX, FREE_MAX), [FREE_MAX]);
});

test("a bigger file is cut in even slices of whole MiB, the sum is the file", () => {
    for (const limit of [FREE_MAX, PREMIUM_MAX]) {
        for (const size of [
            limit + 1,
            limit * 2 - 7,
            limit * 3 + 12345,
            sliceMax(limit) * 4,
            sliceMax(limit) * 4 + 1,
        ]) {
            const sizes = splitSizes(size, limit);
            assert.equal(
                sizes.reduce((a, b) => a + b, 0),
                size,
            );
            assert.ok(sizes.every((s) => s > 0 && s <= sliceMax(limit)));
            // all but the last start and end on a whole MiB
            assert.ok(sizes.slice(0, -1).every((s) => s % MiB === 0));
        }
    }
    assert.equal(sliceMax(FREE_MAX), 1900 * MiB);
    assert.equal(splitSizes(FREE_MAX + 1, FREE_MAX).length, 2);
});

test("slices are named like 7-Zip volumes", () => {
    assert.equal(pieceName("film.mkv", 0), "film.mkv.001");
    assert.equal(pieceName("film.mkv", 11), "film.mkv.012");
});

test("messagesOf lists every message of a record", () => {
    assert.deepEqual(messagesOf({ file_id: 5 }), [5]);
    assert.deepEqual(messagesOf({}), []);
    assert.deepEqual(
        messagesOf({ file_id: 5, parts: [{ id: 5 }, { id: 9 }] }),
        [5, 9],
    );
    // one part is the same as none
    assert.deepEqual(messagesOf({ file_id: 5, parts: [{ id: 5 }] }), [5]);
});

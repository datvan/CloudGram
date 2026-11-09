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

import { test } from "node:test";
import assert from "node:assert/strict";
import { treeStats } from "../../src/services/treeStats.js";
import { sanitizeDiag } from "../diagSchema.js";

test("tree stats count UTF-8 JSON values and pass diagnostics schema", () => {
    const records = [
        {
            type: "file",
            name: "é",
            thumbData: "a",
            thumbnail: "abcd",
            labels: ["x"],
            extra: 12,
        },
        { type: "folder", name: "hi", thumbnailBlob: null },
        { deleted: true },
    ];
    const { totals, maxima } = treeStats(records);
    assert.deepEqual(totals, {
        records: 3,
        tombstones: 1,
        folders: 1,
        files: 1,
        thumbs: 1,
        recordBytes: records.reduce(
            (sum, record) => sum + Buffer.byteLength(JSON.stringify(record)),
            0,
        ),
        name: 8,
        thumbData: 9,
        thumbnailBlob: 4,
        storyboard: 0,
        enc: 0,
        parts: 0,
        share: 0,
        labels: 5,
        other: 20,
    });
    assert.equal(maxima.name, 4);
    assert.equal(maxima.thumbData, 6);
    assert.equal(maxima.other, 8);
    assert.equal(
        maxima.recordBytes,
        Math.max(
            ...records.map((record) =>
                Buffer.byteLength(JSON.stringify(record)),
            ),
        ),
    );
    const context = {
        seq: 1,
        t: 1,
        ts: 1,
        tab: "abcd",
        build: "00000000",
        br: "chrome/1",
        fsa: true,
        uploadOwner: true,
        logOwner: true,
    };
    for (const [evt, fields] of [
        ["tree.stats", totals],
        ["tree.stats.max", maxima],
    ]) {
        const input = { evt, ...context, ...fields };
        assert.deepEqual(sanitizeDiag(input), { event: input, dropped: 0 });
    }
});

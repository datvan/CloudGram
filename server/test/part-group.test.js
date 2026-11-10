import assert from "node:assert/strict";
import test from "node:test";

import {
    missingPieces,
    partChain,
    partsOf,
} from "../../src/utils/partGroup.js";

const file = (name, extra = {}) => ({
    id: name,
    name,
    parent: "f",
    file_id: 1,
    ...extra,
});

test("parts of one video are chained in order, from any part", () => {
    const list = [
        file("a.part002.mp4"),
        file("other.mp4"),
        file("a.part001.mp4"),
        file("a.part003.mp4"),
    ];
    const got = partChain(list[0], list);
    assert.deepEqual(
        got.chain.map((r) => r.name),
        ["a.part001.mp4", "a.part002.mp4", "a.part003.mp4"],
    );
    assert.equal(got.index, 1);
});

test("the command from the dialog starts at part000", () => {
    const list = [file("a.part000.mp4"), file("a.part001.mp4")];
    assert.equal(partChain(list[1], list).chain.length, 2);
});

test("a lone part, another video's parts, another folder or an unfinished part do not join", () => {
    const one = file("a.part001.mp4");
    assert.equal(partChain(one, [one]), null);
    assert.equal(partChain(file("plain.mp4"), []), null);
    const list = [
        file("a.part001.mp4"),
        file("b.part002.mp4"),
        file("a.part002.mp4", { parent: "g" }),
        file("a.part003.mp4", { file_id: null }),
        file("a.part004.mp4", { trashedAt: 5 }),
    ];
    assert.equal(partChain(list[0], list), null);
});

test("a gap ends the chain", () => {
    const list = [
        file("a.part001.mp4"),
        file("a.part002.mp4"),
        file("a.part004.mp4"),
        file("a.part005.mp4"),
    ];
    assert.equal(partChain(list[0], list).chain.length, 2);
    assert.equal(partChain(list[3], list).chain.length, 2);
});

test("partsOf counts the finished parts a video was cut into", () => {
    const f = (name, extra) => file(name, { type: "file", ...extra });
    const list = [
        f("a.part001.mp4"),
        f("a.part002.mp4"),
        f("a.part003.mp4", { trashedAt: 1 }),
        f("a.part004.mp4", { file_id: null }),
        f("a.part005.mp4", { parent: "other" }),
        f("b.part001.mp4"),
    ];
    assert.equal(partsOf("a.mkv", "f", list), 2);
    assert.equal(partsOf("c.mkv", "f", list), 0);
});

test("missingPieces names the pieces not safely on Drive", () => {
    const pieces = [
        { name: "a.part001.mp4", size: 10 },
        { name: "a.part002.mp4", size: 10 },
    ];
    const rec = (name, extra) =>
        file(name, { type: "file", size: 10, ...extra });
    const all = [rec("a.part001.mp4"), rec("a.part002.mp4")];
    assert.deepEqual(missingPieces(pieces, all, "f"), []);
    // unfinished, trashed, another size, another folder or renamed: missing
    assert.deepEqual(
        missingPieces(
            pieces,
            [rec("a.part001.mp4", { file_id: null }), rec("a.part002.mp4")],
            "f",
        ),
        ["a.part001.mp4"],
    );
    assert.deepEqual(
        missingPieces(
            pieces,
            [rec("a.part001.mp4", { trashedAt: 1 }), rec("a.part002.mp4")],
            "f",
        ),
        ["a.part001.mp4"],
    );
    assert.deepEqual(
        missingPieces(
            pieces,
            [rec("a.part001.mp4", { size: 9 }), rec("a.part002 (1).mp4")],
            "f",
        ),
        ["a.part001.mp4", "a.part002.mp4"],
    );
    assert.deepEqual(missingPieces(pieces, all, "other"), [
        "a.part001.mp4",
        "a.part002.mp4",
    ]);
    // root folder: null and undefined are the same place
    assert.deepEqual(
        missingPieces(
            pieces,
            [rec("a.part001.mp4", { parent: null })],
            undefined,
        ),
        ["a.part002.mp4"],
    );
});

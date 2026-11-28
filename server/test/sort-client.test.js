import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSort, nextSort } from "../../src/utils/sort.js";

test("stored sort is validated and defaults safely", () => {
    for (const value of [
        null,
        "",
        "bad",
        "null",
        "{}",
        '{"key":"size","dir":"up"}',
        '{"key":"bad","dir":"desc"}',
    ]) {
        assert.deepEqual(parseSort(value), { key: "name", dir: "asc" });
    }
    for (const key of ["name", "updatedAt", "size"]) {
        for (const dir of ["asc", "desc"]) {
            assert.deepEqual(parseSort(JSON.stringify({ key, dir })), {
                key,
                dir,
            });
        }
    }
});

test("menu selection changes only the chosen sort field", () => {
    const sort = { key: "name", dir: "desc" };
    assert.deepEqual(nextSort(sort, "key", "size"), {
        key: "size",
        dir: "desc",
    });
    assert.deepEqual(nextSort(sort, "dir", "asc"), { key: "name", dir: "asc" });
    assert.deepEqual(sort, { key: "name", dir: "desc" });
});

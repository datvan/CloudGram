import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function setup(overrides = {}) {
    const source = (
        await readFile(
            new URL("../../src/utils/thumbnails.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const events = [];
    const api = vm.runInNewContext(`${source}\n;({ makeThumb, probeVideo })`, {
        diag: (evt, fields) => events.push({ evt, ...fields }),
        File,
        Blob,
        URL,
        setTimeout,
        clearTimeout,
        onClientChange() {},
        ...overrides,
    });
    return { ...api, events };
}

test("thumbnail failures emit one sanitized event", async () => {
    const h = await setup({
        createImageBitmap: async () => {
            throw Error("private path");
        },
    });
    await h.makeThumb(new File(["x"], "secret.png", { type: "image/png" }));
    await h.probeVideo(new File(["x"], "secret.avi", { type: "video/avi" }));
    await h.makeThumb({
        type: "image/png",
        name: "secret",
        size: 101 * 1024 ** 2,
    });
    assert.deepEqual(
        h.events.map(({ reason }) => reason),
        ["decode", "unsupported", "too_large"],
    );
    assert.deepEqual(
        h.events.map(({ mime }) => mime),
        ["image/png", "video/avi", "image/png"],
    );
    assert.ok(
        h.events.every(
            (e) =>
                Object.keys(e).sort().join(",") === "evt,kind,mime,reason,size",
        ),
    );
});

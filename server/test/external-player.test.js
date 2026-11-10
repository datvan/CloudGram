// The page half of "open in PotPlayer/VLC/mpv" (src/services/externalPlayer.js,
// answering the server's relay in server/play.js, tested in play.test.js) and
// the .ts rule (src/services/convert.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function load(path, globals, exports) {
    const source = (await readFile(new URL(path, import.meta.url), "utf8"))
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const context = vm.createContext({
        console: { log() {} },
        JSON,
        setTimeout,
        ...globals,
    });
    return vm.runInContext(`${source}\n;({${exports.join(",")}})`, context);
}

const MB = 1024 * 1024;

test(".ts is a video only when it is big enough to be one", async () => {
    const { isTsVideo, needsConvert } = await load(
        "../../src/services/convert.js",
        {},
        ["isTsVideo", "needsConvert"],
    );
    // TypeScript source is small; a transport stream is not
    assert.equal(isTsVideo({ name: "app.ts", size: 4000 }), false);
    assert.equal(isTsVideo({ name: "clip.TS", size: 50 * MB }), true);
    assert.equal(isTsVideo({ name: "clip.mp4", size: 50 * MB }), false);
    assert.equal(needsConvert({ name: "clip.ts", size: 50 * MB }), true);
    assert.equal(needsConvert({ name: "app.ts", size: 4000 }), false);
    assert.equal(needsConvert({ name: "a.mts", size: 10 }), true);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHUNK = 2 * MB;

/** The page's service with a fake api and a fake Telegram read. */
function relay({ api, readRange, puts = [] }) {
    return load(
        "../../src/services/externalPlayer.js",
        {
            window: { location: { origin: "https://cg.test" } },
            api,
            isOnline: () => true,
            readRange,
            putPlayChunk: async (id, index, bytes) =>
                puts.push([id, index, bytes.byteLength]),
        },
        ["startRelay"],
    );
}

const read = async (r, start, end) => ({
    size: 3 * CHUNK - 5,
    type: "video/mp2t",
    bytes: new ArrayBuffer(end - start + 1),
});

test("startRelay makes a session, answers the server's chunk requests, stops", async () => {
    const calls = [];
    const puts = [];
    const asked = [1, 2];
    const reads = [];
    const m = await relay({
        puts,
        readRange: async (r, start, end) => {
            reads.push([start, end]);
            return read(r, start, end);
        },
        api: {
            createPlay: async (body) => {
                calls.push(["create", body]);
                return { id: "abc", chunk: CHUNK, path: "/api/p/abc/clip.ts" };
            },
            playNext: async () => {
                if (asked.length) return { index: asked.shift() };
                await wait(5);
                return { index: null };
            },
            failPlay: async () => {},
            closePlay: async (id) => calls.push(["close", id]),
        },
    });
    const record = { file_id: 7, name: "clip.ts" };
    const session = await m.startRelay(record);
    assert.equal(session.url, "https://cg.test/api/p/abc/clip.ts");
    // the same video is not opened twice
    assert.equal(await m.startRelay(record), session);
    await wait(40);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), {
        name: "clip.ts",
        size: 3 * CHUNK - 5,
        type: "video/mp2t",
    });
    // the probe, then chunk 1 whole, then the short last chunk
    assert.deepEqual(reads.slice(1).sort(), [
        [CHUNK, 2 * CHUNK - 1],
        [2 * CHUNK, 3 * CHUNK - 6],
    ]);
    assert.deepEqual(puts.map((p) => p[1]).sort(), [1, 2]);
    assert.equal(puts.find((p) => p[1] === 2)[2], CHUNK - 5);

    await session.stop();
    assert.deepEqual(calls.at(-1), ["close", "abc"]);
});

test("a read that fails tells the server, so the player is cut and not fed junk", async () => {
    const failed = [];
    let once = true;
    const m = await relay({
        readRange: async (r, start, end) => {
            if (start === 0) return read(r, start, end);
            throw new Error("failed");
        },
        api: {
            createPlay: async () => ({ id: "x", chunk: CHUNK, path: "/p" }),
            playNext: async () => {
                if (once) {
                    once = false;
                    return { index: 1 };
                }
                await wait(5);
                return { index: null };
            },
            failPlay: async (id, index) => failed.push([id, index]),
            closePlay: async () => {},
        },
    });
    const session = await m.startRelay({ file_id: 1, name: "a.mkv" });
    await wait(40);
    assert.deepEqual(JSON.parse(JSON.stringify(failed)), [["x", 1]]);
    await session.stop();
});

test("startRelay says which part failed", async () => {
    const make = (readRange, createPlay) =>
        relay({ readRange, api: { createPlay } });
    const record = { file_id: 1, name: "a.ts" };
    const refused = (code) => async () => {
        throw Object.assign(new Error(code), { code });
    };

    let m = await make(refused("x"), async () => ({}));
    await assert.rejects(m.startRelay(record), { code: "read" });
    for (const [code, want] of [
        ["play_off", "off"],
        ["play_busy", "busy"],
        ["disk_full", "disk"],
        ["offline", "server"],
    ]) {
        m = await make(read, refused(code));
        await assert.rejects(m.startRelay(record), { code: want });
    }
});

test("a Telegram reconnect is waited out, not passed to the player", async () => {
    let tries = 0;
    const puts = [];
    let once = true;
    const m = await relay({
        puts,
        readRange: async (r, start, end) => {
            if (start > 0 && (tries += 1) < 2) throw new Error("offline");
            return read(r, start, end);
        },
        api: {
            createPlay: async () => ({ id: "w", chunk: CHUNK, path: "/p" }),
            playNext: async () => {
                if (once) {
                    once = false;
                    return { index: 1 };
                }
                await wait(5);
                return { index: null };
            },
            failPlay: async () => assert.fail("must not fail"),
            closePlay: async () => {},
        },
    });
    const session = await m.startRelay({ file_id: 9, name: "a.ts" });
    await wait(2300);
    assert.deepEqual(
        puts.map((p) => p[1]),
        [1],
    );
    await session.stop();
});

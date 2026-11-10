// The page half of "open in PotPlayer/VLC/mpv" (src/services/externalPlayer.js)
// and the .ts rule (src/services/convert.js). The helper half is tested in
// helper-player.test.js against the real helper.
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

const response = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
});

test("externalPlayers lists what the helper found, in the order to offer", async () => {
    const run = (status) =>
        load(
            "../../src/services/externalPlayer.js",
            { helperStatus: async () => status },
            ["externalPlayers"],
        ).then((m) => m.externalPlayers());

    assert.deepEqual(JSON.parse(JSON.stringify(await run(null))), {
        helper: false,
        players: [],
    });
    assert.deepEqual(
        JSON.parse(
            JSON.stringify(await run({ players: ["mpv", "vlc", "other"] })),
        ),
        {
            helper: true,
            outdated: false,
            players: ["vlc", "mpv"],
        },
    );
    // a helper from before the bridge has no list at all
    assert.equal((await run({ ffmpeg: true })).outdated, true);
});

test("openInPlayer sends a player name and no path, then serves the helper's ranges", async () => {
    const calls = [];
    const asked = [{ id: "0", start: 10, end: 19 }];
    const record = { file_id: 7, name: "clip.ts" };
    const reads = [];
    const m = await load(
        "../../src/services/externalPlayer.js",
        {
            readRange: async (r, start, end) => {
                reads.push([start, end]);
                return {
                    size: 100,
                    type: "video/mp2t",
                    bytes: new ArrayBuffer(end - start + 1),
                };
            },
            call: async (path, init = {}) => {
                calls.push({ path, init });
                if (path === "/play") return response(200, { token: "tok" });
                if (path === "/bridge/tok/next") {
                    const next = asked.shift();
                    return next
                        ? response(200, next)
                        : // nothing more: the video was closed
                          response(410, {});
                }
                return response(200, {});
            },
        },
        ["openInPlayer"],
    );

    const opened = await m.openInPlayer(record, "vlc");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const play = calls.find((c) => c.path === "/play");
    assert.deepEqual(JSON.parse(play.init.body), {
        name: "clip.ts",
        size: 100,
        type: "video/mp2t",
        player: "vlc",
    });
    // the first probe, then the helper's request
    assert.deepEqual(reads, [
        [0, 0],
        [10, 19],
    ]);
    const answer = calls.find((c) => c.path === "/bridge/tok/0");
    assert.equal(answer.init.method, "POST");
    assert.equal(answer.init.body.byteLength, 10);

    await opened.stop();
    assert.ok(
        calls.some(
            (c) => c.path === "/bridge/tok" && c.init.method === "DELETE",
        ),
    );
});

test("a read that fails tells the helper, so the player is cut and not fed junk", async () => {
    const calls = [];
    let once = true;
    const m = await load(
        "../../src/services/externalPlayer.js",
        {
            readRange: async (r, start) => {
                if (start === 0) return { size: 50, type: "video/mp4" };
                throw new Error("failed");
            },
            call: async (path, init = {}) => {
                calls.push(path);
                if (path === "/play") return response(200, { token: "t" });
                if (path === "/bridge/t/next" && once) {
                    once = false;
                    return response(200, { id: "3", start: 5, end: 9 });
                }
                return path.endsWith("/next")
                    ? response(410, {})
                    : response(200, {});
            },
        },
        ["openInPlayer"],
    );
    const opened = await m.openInPlayer({ file_id: 1, name: "a.mkv" }, "mpv");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(calls.includes("/bridge/t/3?error=1"));
    await opened.stop();
});

test("openInPlayer says which part failed", async () => {
    const make = (readRange, call) =>
        load("../../src/services/externalPlayer.js", { readRange, call }, [
            "openInPlayer",
        ]);
    const record = { file_id: 1, name: "a.ts" };
    const ok = async () => ({ size: 9, type: "video/mp2t" });

    let m = await make(
        async () => {
            throw new Error("x");
        },
        async () => response(200, {}),
    );
    await assert.rejects(m.openInPlayer(record, "vlc"), { code: "read" });

    m = await make(ok, async () => {
        throw new TypeError("fetch failed");
    });
    await assert.rejects(m.openInPlayer(record, "vlc"), { code: "helper" });

    m = await make(ok, async () => response(412, {}));
    await assert.rejects(m.openInPlayer(record, "vlc"), { code: "player" });
});

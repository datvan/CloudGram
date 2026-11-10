import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

// The local helper (public/helper) opens a video in a player: the player reads
// a local address, and the helper asks the page (played here by `page()`) for
// the bytes. "mpv" is node itself, which fails at once on the address, so no
// real player starts.
const helper = fileURLToPath(
    new URL("../../public/helper/cloudgram-helper.mjs", import.meta.url),
);
const PORT = 48000 + Math.floor(Math.random() * 900);
const ORIGIN = "https://cloudgram.datvan.com";
const VIDEO = Buffer.alloc(5_000_000);
for (let i = 0; i < VIDEO.length; i++) VIDEO[i] = (i * 7 + (i >> 8)) & 255;

let child;

function call(method, url, { headers = {}, body, host, origin = true } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: PORT,
                method,
                path: url,
                headers: {
                    ...(origin ? { Origin: ORIGIN, "X-CloudGram": "1" } : {}),
                    ...(host ? { Host: host } : {}),
                    ...headers,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("aborted", () => resolve({ status: "cut" }));
                res.on("error", () => resolve({ status: "cut" }));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        );
        req.on("error", reject);
        req.end(body);
    });
}
const json = (r) => JSON.parse(r.body.toString());

before(async () => {
    child = spawn(process.execPath, [helper], {
        env: {
            ...process.env,
            CLOUDGRAM_HELPER_PORT: String(PORT),
            CLOUDGRAM_MPV: process.execPath,
        },
        stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve) => child.stdout.once("data", resolve));
});

after(() => child.kill());

/** What the CloudGram page does: answers the helper's requests with bytes. */
function page(token, { fail = false } = {}) {
    let stop = false;
    const asked = [];
    const loop = async () => {
        while (!stop) {
            const next = await call("GET", `/bridge/${token}/next`);
            if (next.status === 204) continue;
            if (next.status !== 200) return;
            const { id, start, end } = json(next);
            asked.push([start, end]);
            await call(
                "POST",
                `/bridge/${token}/${id}${fail ? "?error=1" : ""}`,
                {
                    headers: { "Content-Type": "application/octet-stream" },
                    // like stream.js: at most two 1 MB parts
                    body: VIDEO.subarray(
                        start,
                        Math.min(end, start + 2 * 1024 * 1024 - 1) + 1,
                    ),
                },
            );
        }
    };
    // several at once, as the page does
    const done = Promise.all([loop(), loop()]);
    return {
        asked,
        stop: async () => {
            stop = true;
            await call("DELETE", `/bridge/${token}`);
            await done;
        },
    };
}

async function open(name = "clip.ts") {
    const res = await call("POST", "/play", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            size: VIDEO.length,
            type: "video/mp2t",
            player: "mpv",
        }),
    });
    assert.equal(res.status, 200);
    const { token, url } = json(res);
    return { token, path: new URL(url).pathname };
}

test("the helper lists the players it found, by name", async () => {
    const status = json(await call("GET", "/status"));
    assert.equal(status.version, 2);
    assert.ok(status.players.includes("mpv"));
    assert.ok(status.players.every((p) => !/[\\/]/.test(p)));
});

test("a player the helper does not know is refused, and no path is taken", async () => {
    for (const player of ["vlc2", "../../bin/sh", "constructor", undefined]) {
        const res = await call("POST", "/play", {
            body: JSON.stringify({ name: "a.ts", size: 10, player }),
        });
        assert.equal(res.status, 412, String(player));
    }
    assert.equal(
        (
            await call("POST", "/play", {
                body: JSON.stringify({ name: "a.ts", size: -1, player: "mpv" }),
            })
        ).status,
        400,
    );
    assert.equal((await call("POST", "/play", { body: "nope" })).status, 400);
    // only the CloudGram page may open a player
    assert.equal(
        (
            await call("POST", "/play", {
                origin: false,
                body: JSON.stringify({ name: "a.ts", size: 10, player: "mpv" }),
            })
        ).status,
        403,
    );
});

test("the player reads the video with Range, the bytes come from the page", async () => {
    const { token, path } = await open("my clip?.ts");
    assert.match(path, /^\/play\/[0-9a-f]{32}\/my%20clip_\.ts$/);
    const fake = page(token);

    // the player sends no Origin
    const whole = await call("GET", path, { origin: false });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["content-length"], String(VIDEO.length));
    assert.equal(whole.headers["content-type"], "video/mp2t");
    assert.ok(whole.body.equals(VIDEO));

    const range = await call("GET", path, {
        origin: false,
        headers: { Range: "bytes=1000-4999" },
    });
    assert.equal(range.status, 206);
    assert.equal(
        range.headers["content-range"],
        `bytes 1000-4999/${VIDEO.length}`,
    );
    assert.ok(range.body.equals(VIDEO.subarray(1000, 5000)));

    const open_ended = await call("GET", path, {
        origin: false,
        headers: { Range: "bytes=4999000-" },
    });
    assert.equal(open_ended.status, 206);
    assert.ok(open_ended.body.equals(VIDEO.subarray(4999000)));

    // the end of the file: where a player looks for the index of an mp4
    const tail = await call("GET", path, {
        origin: false,
        headers: { Range: "bytes=-100" },
    });
    assert.equal(tail.status, 206);
    assert.ok(tail.body.equals(VIDEO.subarray(VIDEO.length - 100)));

    assert.equal(
        (
            await call("GET", path, {
                origin: false,
                headers: { Range: `bytes=${VIDEO.length}-` },
            })
        ).status,
        416,
    );
    const head = await call("HEAD", path, { origin: false });
    assert.equal(head.status, 200);
    assert.equal(head.headers["accept-ranges"], "bytes");
    // never asked for more than it needed
    assert.ok(fake.asked.every(([a, b]) => b - a + 1 <= 2 * 1024 * 1024));
    await fake.stop();
});

test("a wrong token or host gets nothing", async () => {
    const { token, path } = await open();
    const fake = page(token);
    const wrong = path.replace(token, "0".repeat(32));
    assert.equal((await call("GET", wrong, { origin: false })).status, 404);
    assert.equal(
        (await call("GET", path, { origin: false, host: "evil.example" }))
            .status,
        403,
    );
    // the bridge answers only the CloudGram page
    assert.equal(
        (await call("GET", `/bridge/${token}/next`, { origin: false })).status,
        403,
    );
    assert.equal((await call("POST", path, { origin: false })).status, 404);
    await fake.stop();
});

test("when the page cannot read, the player's stream is cut, not filled with junk", async () => {
    const { token, path } = await open();
    const fake = page(token, { fail: true });
    // headers go out before the first bytes, so the cut shows as a reset or
    // as a body shorter than promised
    const res = await call("GET", path, { origin: false }).catch(() => ({
        status: "cut",
    }));
    assert.ok(res.status === "cut" || res.body.length < VIDEO.length);
    await fake.stop();
});

test("closing the video ends the address", async () => {
    const { token, path } = await open();
    const fake = page(token);
    assert.equal((await call("GET", path, { origin: false })).status, 200);
    await fake.stop();
    assert.equal((await call("GET", path, { origin: false })).status, 404);
    assert.equal((await call("GET", `/bridge/${token}/next`)).status, 404);
});

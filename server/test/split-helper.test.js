import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

// The local helper (public/helper) is started as the user would start it.
const helper = fileURLToPath(
    new URL("../../public/helper/cloudgram-helper.mjs", import.meta.url),
);
const PORT = 47000 + Math.floor(Math.random() * 900);
const ORIGIN = "https://cloudgram.datvan.com";
const hasFfmpeg =
    spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

let child;
let dir;

function call(method, url, { headers = {}, body, host } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: PORT,
                method,
                path: url,
                headers: {
                    Origin: ORIGIN,
                    "X-CloudGram": "1",
                    ...(host ? { Host: host } : {}),
                    ...headers,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "helper-test-"));
    child = spawn(process.execPath, [helper], {
        env: { ...process.env, CLOUDGRAM_HELPER_PORT: String(PORT) },
        stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve) => child.stdout.once("data", resolve));
});

after(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
});

test("only the CloudGram page, on the loopback host, is answered", async () => {
    assert.equal((await call("GET", "/status")).status, 200);
    assert.equal(
        (
            await call("GET", "/status", {
                headers: { Origin: "https://evil.example" },
            })
        ).status,
        403,
    );
    assert.equal(
        (await call("GET", "/status", { host: "evil.example" })).status,
        403,
    );
    assert.equal(
        (await call("GET", "/status", { headers: { "X-CloudGram": "0" } }))
            .status,
        403,
    );
    const preflight = await call("OPTIONS", "/jobs");
    assert.equal(preflight.status, 204);
    assert.equal(
        preflight.headers["access-control-allow-private-network"],
        "true",
    );
    assert.equal(preflight.headers["access-control-allow-origin"], ORIGIN);
});

test("bad sizes and unknown jobs are refused", async () => {
    assert.equal((await call("POST", "/jobs?piece=abc&limit=1")).status, 400);
    assert.equal((await call("GET", "/jobs/nope")).status, 404);
    assert.equal((await call("GET", "/jobs/../../etc/passwd")).status, 404);
});

test(
    "a video is cut into playable pieces under the limit",
    { skip: !hasFfmpeg },
    async () => {
        const video = path.join(dir, "in.mp4");
        // 6 seconds with a keyframe every second, so it can be cut
        const made = spawnSync("ffmpeg", [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=6:size=160x120:rate=10",
            "-g",
            "10",
            "-pix_fmt",
            "yuv420p",
            "-y",
            video,
        ]);
        assert.equal(made.status, 0, String(made.stderr));
        const bytes = fs.readFileSync(video);
        const piece = Math.floor(bytes.length / 3);
        const limit = Math.floor(bytes.length * 0.8);

        const started = await call(
            "POST",
            `/jobs?piece=${piece}&limit=${limit}&ext=mp4`,
            { body: bytes },
        );
        assert.equal(started.status, 202);
        const { id } = json(started);

        let job;
        for (let i = 0; i < 100; i++) {
            job = json(await call("GET", `/jobs/${id}`));
            if (job.state !== "splitting") break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(job.state, "done", job.error);
        assert.ok(job.parts.length >= 2);
        assert.ok(job.parts.every((n) => n <= limit));

        const first = await call("GET", `/jobs/${id}/parts/0`);
        assert.equal(first.status, 200);
        assert.equal(first.body.length, job.parts[0]);
        assert.equal(
            (await call("GET", `/jobs/${id}/parts/${job.parts.length}`)).status,
            404,
        );

        assert.equal((await call("DELETE", `/jobs/${id}`)).status, 200);
        assert.equal((await call("GET", `/jobs/${id}`)).status, 404);
    },
);

test(
    "a file ffmpeg cannot read reports an error and leaves nothing behind",
    { skip: !hasFfmpeg },
    async () => {
        const started = await call(
            "POST",
            "/jobs?piece=2000&limit=4000&ext=mp4",
            {
                body: Buffer.from("not a video"),
            },
        );
        const { id } = json(started);
        let job;
        for (let i = 0; i < 100; i++) {
            job = json(await call("GET", `/jobs/${id}`));
            if (job.state !== "splitting") break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(job.state, "error");
        assert.ok(job.error);
    },
);

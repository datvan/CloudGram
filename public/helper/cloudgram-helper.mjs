#!/usr/bin/env node
// CloudGram helper: cuts a video that is too big for Telegram into pieces with
// the ffmpeg on this computer, and hands the pieces back to the CloudGram page.
//
//   node cloudgram-helper.mjs
//
// Needs Node 20+ and ffmpeg (+ ffprobe) on PATH. Nothing is installed and
// nothing leaves this computer: it listens on 127.0.0.1 only, answers only the
// CloudGram page, and the pieces never go anywhere but back to that page.
// Pieces are cut by copying the streams (no re-encoding, no quality loss),
// so neither CPU nor GPU encoding is involved. Stop it with Ctrl+C.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.CLOUDGRAM_HELPER_PORT) || 47633;
// the page that may talk to this program; add more with CLOUDGRAM_ORIGINS=a,b
const ORIGINS = new Set([
    "https://cloudgram.datvan.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.CLOUDGRAM_ORIGINS?.split(",").filter(Boolean) ?? []),
]);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const ROOT = path.join(os.tmpdir(), "cloudgram-helper");
const STALE_MS = 6 * 3600 * 1000;
const TRIES = 3;

/** id -> { dir, state: uploading|splitting|done|error, parts: [bytes], error } */
const jobs = new Map();

const has = (bin) =>
    spawnSync(bin, ["-version"], { stdio: "ignore", windowsHide: true })
        .status === 0;
const busy = () =>
    [...jobs.values()].some(
        (j) => j.state === "uploading" || j.state === "splitting",
    );
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const partFile = (dir, n) =>
    path.join(dir, `part${String(n).padStart(3, "0")}.mp4`);

function sweep() {
    fs.mkdirSync(ROOT, { recursive: true });
    for (const name of fs.readdirSync(ROOT)) {
        const dir = path.join(ROOT, name);
        if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS) rm(dir);
    }
}

// Only fixed arguments and file names made here go to the programs below, and
// never through a shell, so nothing the page sends can become a command.
function run(bin, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            cwd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0
                ? resolve(out)
                : reject(new Error(err.trim() || `exit ${code}`)),
        );
    });
}

const listParts = (dir) => {
    const found = [];
    for (let n = 0; fs.existsSync(partFile(dir, n)); n++)
        found.push(fs.statSync(partFile(dir, n)).size);
    return found;
};

async function split(job, input, size, piece, limit) {
    try {
        const duration = Number(
            await run(
                FFPROBE,
                [
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "csv=p=0",
                    input,
                ],
                job.dir,
            ),
        );
        if (!(duration > 0)) throw new Error("Không đọc được thời lượng video");
        let seconds = Math.max(1, Math.floor((duration * piece) / size));
        for (let attempt = 1; ; attempt++) {
            await run(
                FFMPEG,
                [
                    "-hide_banner",
                    "-nostdin",
                    "-y",
                    "-i",
                    input,
                    "-map",
                    "0:v",
                    "-map",
                    "0:a?",
                    "-c",
                    "copy",
                    "-f",
                    "segment",
                    "-segment_time",
                    String(seconds),
                    "-reset_timestamps",
                    "1",
                    "-segment_format_options",
                    "movflags=+faststart",
                    "part%03d.mp4",
                ],
                job.dir,
            );
            const parts = listParts(job.dir);
            if (!parts.length) throw new Error("ffmpeg không tạo ra phần nào");
            if (parts.every((bytes) => bytes <= limit)) {
                job.parts = parts;
                break;
            }
            // cuts land on keyframes, so a piece can run over: cut shorter
            if (attempt >= TRIES || seconds === 1)
                throw new Error("Có phần vẫn lớn hơn giới hạn của Telegram");
            parts.forEach((_, n) => fs.rmSync(partFile(job.dir, n)));
            seconds = Math.max(1, Math.floor(seconds * 0.8));
        }
        // the original is not needed any more; saves the disk it took
        fs.rmSync(input, { force: true });
        job.state = "done";
    } catch (err) {
        job.state = "error";
        job.error = String(err.message ?? err);
        rm(job.dir);
    }
}

function reply(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

async function handle(req, res) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    // Host: stops DNS rebinding; Origin: only the CloudGram page, not any
    // other website open in the browser
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`)
        return reply(res, 403, { error: "host" });
    if (!ORIGINS.has(origin)) return reply(res, 403, { error: "origin" });
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CloudGram");
    // Chrome asks before a public page may reach a local program
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }
    if (req.headers["x-cloudgram"] !== "1")
        return reply(res, 403, { error: "header" });

    const url = new URL(req.url, "http://local");
    const route = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/status")
        return reply(res, 200, {
            ok: true,
            version: 1,
            platform: process.platform,
            ffmpeg: has(FFMPEG),
            ffprobe: has(FFPROBE),
        });

    if (req.method === "POST" && url.pathname === "/jobs") {
        const piece = Number(url.searchParams.get("piece"));
        const limit = Number(url.searchParams.get("limit"));
        const ext = /^[a-z0-9]{1,5}$/i.test(url.searchParams.get("ext") ?? "")
            ? url.searchParams.get("ext")
            : "bin";
        if (!(piece >= 1024 && limit >= piece && limit <= 2 ** 33))
            return reply(res, 400, { error: "size" });
        if (!has(FFMPEG) || !has(FFPROBE))
            return reply(res, 412, { error: "ffmpeg" });
        if (busy()) return reply(res, 409, { error: "busy" });
        sweep();
        const id = crypto.randomBytes(8).toString("hex");
        const job = { dir: path.join(ROOT, id), state: "uploading", parts: [] };
        fs.mkdirSync(job.dir, { recursive: true });
        jobs.set(id, job);
        const input = `in.${ext}`;
        try {
            await pipeline(
                req,
                fs.createWriteStream(path.join(job.dir, input)),
            );
        } catch {
            // the page closed or cancelled while sending
            jobs.delete(id);
            rm(job.dir);
            return undefined;
        }
        const size = fs.statSync(path.join(job.dir, input)).size;
        job.state = "splitting";
        split(job, input, size, piece, limit);
        return reply(res, 202, { id });
    }

    const job = jobs.get(route[1]);
    if (route[0] === "jobs" && job) {
        if (req.method === "GET" && route.length === 2)
            return reply(res, 200, {
                state: job.state,
                parts: job.parts,
                error: job.error,
            });
        if (
            req.method === "GET" &&
            route[2] === "parts" &&
            job.state === "done"
        ) {
            const n = Number(route[3]);
            if (!Number.isInteger(n) || n < 0 || n >= job.parts.length)
                return reply(res, 404, { error: "part" });
            res.writeHead(200, {
                "Content-Type": "video/mp4",
                "Content-Length": job.parts[n],
            });
            return pipeline(
                fs.createReadStream(partFile(job.dir, n)),
                res,
            ).catch(() => {});
        }
        if (req.method === "DELETE" && route.length === 2) {
            jobs.delete(route[1]);
            rm(job.dir);
            return reply(res, 200, { ok: true });
        }
    }
    return reply(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) =>
    handle(req, res).catch((err) => {
        if (!res.headersSent)
            reply(res, 500, { error: String(err.message ?? err) });
        else res.destroy();
    }),
);
// a file of several GB takes longer than Node's default 5 minutes to arrive
server.requestTimeout = 0;

sweep();
server.listen(PORT, "127.0.0.1", () => {
    console.log(`CloudGram helper dang chay tai 127.0.0.1:${PORT}`);
    console.log(
        `ffmpeg: ${has(FFMPEG) ? "co" : "CHUA CAI"}, ffprobe: ${
            has(FFPROBE) ? "co" : "CHUA CAI"
        }`,
    );
    console.log("Giu cua so nay mo trong luc tai len. Bam Ctrl+C de tat.");
});
const bye = () => {
    rm(ROOT);
    process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);

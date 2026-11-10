#!/usr/bin/env node
// CloudGram helper, two jobs for the CloudGram page:
//  - cuts a video that is too big for Telegram into pieces with the ffmpeg on
//    this computer, and hands the pieces back;
//  - opens a video in PotPlayer, VLC or mpv: it serves a local address the
//    player reads (with Range, so seeking works) and asks the page, which has
//    the Telegram session, for each piece of bytes the player wants.
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
// the players the page may ask for, by name only: it never sends a path, so a
// flaw in the page cannot make this program run something else. A path can be
// set here, by whoever starts the program, with these variables.
const PLAYERS = {
    potplayer: "CLOUDGRAM_POTPLAYER",
    vlc: "CLOUDGRAM_VLC",
    mpv: "CLOUDGRAM_MPV",
};
// bytes asked of the page at a time; it answers at most two 1 MB parts
const CHUNK = 2 * 1024 * 1024;
// the page polls at least this often while a video is open; one gone silent
// for SILENT_MS is closed
const POLL_MS = 25000;
const SILENT_MS = 90000;
// a video no player has read from for this long is closed, so the page stops
// polling for one nobody is watching
const IDLE_MS = 30 * 60000;
const ASK_MS = 60000;
const MAX_SESSIONS = 8;

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

const onPath = (bin) => {
    const found = spawnSync(
        process.platform === "win32" ? "where" : "which",
        [bin],
        { encoding: "utf8", windowsHide: true },
    );
    return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : "";
};

/** player name -> program path, for the players this computer has. */
function findPlayers() {
    const programs = [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
    ].filter(Boolean);
    const candidates = { potplayer: [], vlc: [], mpv: [] };
    if (process.platform === "win32") {
        // PotPlayer registers potplayer: with the path of its own program
        const reg = spawnSync(
            "reg",
            ["query", "HKCR\\potplayer\\shell\\open\\command", "/ve"],
            { encoding: "utf8", windowsHide: true },
        );
        const registered = /REG_SZ\s+"?([^"]+?\.exe)/i.exec(
            reg.stdout ?? "",
        )?.[1];
        if (registered) candidates.potplayer.push(registered);
        for (const dir of programs) {
            candidates.potplayer.push(
                path.join(dir, "DAUM", "PotPlayer", "PotPlayerMini64.exe"),
                path.join(dir, "DAUM", "PotPlayer", "PotPlayerMini.exe"),
            );
            candidates.vlc.push(path.join(dir, "VideoLAN", "VLC", "vlc.exe"));
        }
    } else if (process.platform === "darwin") {
        candidates.vlc.push("/Applications/VLC.app/Contents/MacOS/VLC");
    }
    const found = {};
    for (const [name, variable] of Object.entries(PLAYERS)) {
        const exe = [process.env[variable], ...candidates[name]].find(
            (file) => file && fs.existsSync(file),
        );
        // PotPlayer is Windows only and found above; the others may be on PATH
        const installed = exe || (name === "potplayer" ? "" : onPath(name));
        if (installed) found[name] = installed;
    }
    return found;
}
let playersAt = 0;
let playersKnown = {};
const players = () => {
    if (Date.now() - playersAt > 10000) {
        playersKnown = findPlayers();
        playersAt = Date.now();
    }
    return playersKnown;
};

/** token -> an open video: the bytes come from the page, see ask() */
const sessions = new Map();

function closeSession(token) {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    for (const res of session.waiters.splice(0)) {
        clearTimeout(res.timer);
        reply(res, 410, { error: "closed" });
    }
    for (const { reject } of session.pending.values())
        reject(new Error("closed"));
    session.pending.clear();
}

/** Hand queued requests to the page's waiting polls. */
function flush(session) {
    while (session.queue.length && session.waiters.length) {
        const res = session.waiters.shift();
        clearTimeout(res.timer);
        reply(res, 200, session.queue.shift());
    }
}

/** Bytes start..end of the video, as the page reads them from Telegram. */
function ask(session, start, end) {
    const id = String(session.next++);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            session.pending.delete(id);
            session.queue = session.queue.filter((r) => r.id !== id);
            reject(new Error("page did not answer"));
        }, ASK_MS);
        session.pending.set(id, {
            resolve: (bytes) => {
                clearTimeout(timer);
                resolve(bytes);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            },
        });
        session.queue.push({ id, start, end });
        flush(session);
    });
}

/** The player's request: the whole video, or a part of it with Range. */
async function play(req, res, session) {
    const total = session.size;
    let start = 0;
    let end = total - 1;
    let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
        if (m[1] === "") start = Math.max(0, total - Number(m[2]));
        else {
            start = Number(m[1]);
            if (m[2] !== "") end = Math.min(end, Number(m[2]));
        }
        status = 206;
        if (start > end || start >= total) {
            res.writeHead(416, { "Content-Range": `bytes */${total}` });
            return res.end();
        }
    }
    res.writeHead(status, {
        "Content-Type": session.type,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(status === 206
            ? { "Content-Range": `bytes ${start}-${end}/${total}` }
            : {}),
    });
    if (req.method === "HEAD") return res.end();
    let closed = false;
    session.playing += 1;
    res.on("close", () => {
        closed = true;
        session.playing -= 1;
        session.lastPlay = Date.now();
    });
    try {
        for (let at = start; at <= end && !closed; ) {
            const bytes = await ask(session, at, Math.min(end, at + CHUNK - 1));
            if (closed) return undefined;
            // never more than was asked, whatever the page sent
            const chunk = bytes.subarray(0, end - at + 1);
            if (!chunk.length) throw new Error("empty");
            if (!res.write(chunk))
                await new Promise((resolve) => res.once("drain", resolve));
            at += chunk.length;
        }
        res.end();
    } catch {
        // the page is gone or could not read: the player sees a cut stream
        res.destroy();
    }
    return undefined;
}

const readBody = (req, max) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            if (size > max) {
                reject(new Error("too big"));
                req.destroy();
            } else chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });

const safeName = (name) =>
    String(name ?? "")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .slice(0, 200) || "video";

setInterval(() => {
    for (const [token, session] of sessions)
        if (
            Date.now() - session.seen > SILENT_MS ||
            (!session.playing && Date.now() - session.lastPlay > IDLE_MS)
        )
            closeSession(token);
}, 30000).unref();

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
    const url = new URL(req.url, "http://local");
    const route = url.pathname.split("/").filter(Boolean);

    // The player has no Origin or header to show: the token in its address,
    // which only the page was given, is what lets it in.
    if (route[0] === "play" && route.length >= 3) {
        const session = sessions.get(route[1]);
        if (!session || !["GET", "HEAD"].includes(req.method))
            return reply(res, 404, { error: "not found" });
        return play(req, res, session);
    }

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

    if (req.method === "GET" && url.pathname === "/status")
        return reply(res, 200, {
            ok: true,
            version: 2,
            platform: process.platform,
            players: Object.keys(players()),
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

    if (req.method === "POST" && url.pathname === "/play") {
        let want;
        try {
            want = JSON.parse((await readBody(req, 4096)).toString());
        } catch {
            return reply(res, 400, { error: "body" });
        }
        const size = Number(want?.size);
        if (!(Number.isSafeInteger(size) && size > 0))
            return reply(res, 400, { error: "size" });
        const exe = Object.hasOwn(PLAYERS, want?.player)
            ? players()[want.player]
            : undefined;
        if (!exe) return reply(res, 412, { error: "player" });
        const type = /^[\w.+-]+\/[\w.+-]+$/.test(want.type ?? "")
            ? want.type
            : "application/octet-stream";
        const token = crypto.randomBytes(16).toString("hex");
        if (sessions.size >= MAX_SESSIONS)
            closeSession(sessions.keys().next().value);
        sessions.set(token, {
            size,
            type,
            seen: Date.now(),
            lastPlay: Date.now(),
            playing: 0,
            next: 0,
            queue: [],
            waiters: [],
            pending: new Map(),
        });
        const address = `http://127.0.0.1:${PORT}/play/${token}/${encodeURIComponent(
            safeName(want.name),
        )}`;
        // a fixed program and one argument made here, never through a shell
        const child = spawn(exe, [address], {
            detached: true,
            stdio: "ignore",
        });
        child.on("error", () => closeSession(token));
        child.unref();
        return reply(res, 200, { token, url: address });
    }

    if (route[0] === "bridge" && sessions.has(route[1])) {
        const session = sessions.get(route[1]);
        session.seen = Date.now();
        if (req.method === "DELETE" && route.length === 2) {
            closeSession(route[1]);
            return reply(res, 200, { ok: true });
        }
        if (req.method === "GET" && route[2] === "next") {
            const request = session.queue.shift();
            if (request) return reply(res, 200, request);
            res.timer = setTimeout(() => {
                session.waiters = session.waiters.filter((w) => w !== res);
                res.writeHead(204);
                res.end();
            }, POLL_MS);
            res.on("close", () => {
                clearTimeout(res.timer);
                session.waiters = session.waiters.filter((w) => w !== res);
            });
            session.waiters.push(res);
            return undefined;
        }
        if (req.method === "POST" && route.length === 3) {
            const waiting = session.pending.get(route[2]);
            if (!waiting) return reply(res, 404, { error: "request" });
            session.pending.delete(route[2]);
            if (url.searchParams.has("error")) {
                waiting.reject(new Error("page could not read"));
                return reply(res, 200, { ok: true });
            }
            try {
                waiting.resolve(await readBody(req, 2 * CHUNK));
            } catch (error) {
                waiting.reject(error);
                return reply(res, 400, { error: "body" });
            }
            return reply(res, 200, { ok: true });
        }
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

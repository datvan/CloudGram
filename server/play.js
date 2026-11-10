/**
 * Playing a video in PotPlayer, VLC or mpv.
 *
 * A player cannot read from the CloudGram tab, and the tab is the only one
 * holding the Telegram session. So the tab acts as the source and this server
 * as the cache in between: the player reads a Range URL here, the tab is asked
 * (by a long poll) for the 2 MiB chunks the player needs plus some ahead of it,
 * and puts them here. Chunks are kept on disk, a bounded amount, oldest use
 * first out, so seeking back and a slow tab or a slow player are both absorbed.
 *
 * The bytes pass through here as plain video, not ciphertext, and are deleted
 * when the tab closes the video, goes silent or the cap is hit. The player's
 * address carries a random token and nothing else: whoever holds it can watch,
 * until the tab stops.
 *
 *     play/<id>/<n>.bin    chunk n (bytes n*2MiB ...) of one open video
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HttpError } from "./app.js";

const MB = 1024 * 1024;
export const PLAY_CHUNK = 2 * MB;
export const PLAY_LIMITS = {
    // chunks fetched ahead of the player (64 MiB)
    ahead: 32,
    sessionBytes: 512 * MB,
    totalBytes: 1024 * MB,
    perUser: 3,
    total: 8,
    // the tab polls at least every pollMs; silent for silentMs: closed
    pollMs: 20_000,
    silentMs: 90_000,
    // nginx drops an upstream silent for 30 s, so the player is cut before
    waitMs: 25_000,
    maxMs: 12 * 60 * 60 * 1000,
    // keep this much disk free for the rest of the VPS
    diskReserve: 1024 * MB,
};

const idRe = /^[A-Za-z0-9_-]{22}$/;
const typeRe = /^(video|audio)\/[\w.+-]{1,60}$/;

/** What a GET handler returns when it writes the response itself. */
export class PlayReply {
    constructor(run) {
        this.run = run;
    }
}

export class Play {
    constructor({ dir, authenticate, now, enabled = true, limits = {} }) {
        this.dir = dir;
        this.authenticate = authenticate;
        this.now = now;
        this.enabled = enabled;
        this.limits = { ...PLAY_LIMITS, ...limits };
        this.sessions = new Map();
    }

    /** Forget whatever a previous run left behind. */
    async reset() {
        await rm(this.dir, { recursive: true, force: true });
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
    }

    #path(id, index) {
        // ids are generated here, and checked again before a request's reaches
        // a path
        if (!idRe.test(id)) throw new Error("bad play id");
        return join(this.dir, id, `${index}.bin`);
    }

    #session(id) {
        const session = this.sessions.get(id);
        if (!session) throw new HttpError(404, "play_not_found");
        return session;
    }

    #own(user, id) {
        const session = this.#session(id);
        if (session.owner !== user.username)
            throw new HttpError(404, "play_not_found");
        return session;
    }

    #chunkSize(session, index) {
        return Math.min(PLAY_CHUNK, session.size - index * PLAY_CHUNK);
    }

    // ----- the tab's side ---------------------------------------------------

    async create(req, res) {
        if (!this.enabled) throw new HttpError(403, "play_off");
        const { user } = await this.authenticate(req, res);
        const size = Number(req.body.size);
        if (!Number.isSafeInteger(size) || size < 1 || size > 2 ** 42)
            throw new HttpError(400, "bad_size");
        const name = String(req.body.name ?? "")
            // eslint-disable-next-line no-control-regex
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
            .slice(0, 200);
        const type = typeRe.test(req.body.type ?? "")
            ? req.body.type
            : "application/octet-stream";

        const mine = [...this.sessions.values()].filter(
            (s) => s.owner === user.username,
        );
        // opening a fourth video closes the one opened first
        while (mine.length >= this.limits.perUser)
            await this.#drop(mine.shift().id);
        if (this.sessions.size >= this.limits.total)
            throw new HttpError(409, "play_busy");
        const disk = await statfs(this.dir).catch(() => null);
        if (
            disk &&
            disk.bavail * disk.bsize <
                this.limits.diskReserve + this.limits.sessionBytes
        )
            throw new HttpError(507, "disk_full");

        const id = randomBytes(16).toString("base64url");
        await mkdir(join(this.dir, id), { recursive: true, mode: 0o700 });
        this.sessions.set(id, {
            id,
            owner: user.username,
            name: name || "video",
            type,
            size,
            chunks: Math.ceil(size / PLAY_CHUNK),
            created: this.now(),
            seen: this.now(),
            // the player's last request: a tab busy reading from Telegram does not
            // poll, but a player still asking shows the video is being watched
            played: this.now(),
            // chunk -> { bytes, used }
            have: new Map(),
            // chunks the tab was not asked for yet, first to ask at the front
            wanted: [],
            // chunk -> { since, waiters }: asked of the tab, not here yet
            pending: new Map(),
            pollers: [],
            // the chunk the player is reading, for what eviction must spare
            at: 0,
            closed: false,
        });
        const session = this.sessions.get(id);
        return {
            id,
            chunk: PLAY_CHUNK,
            chunks: session.chunks,
            path: `/api/p/${id}/${encodeURIComponent(session.name)}`,
        };
    }

    /** Long poll: the next chunk the tab should fetch, or null after a while. */
    async next(req, res) {
        const { user } = await this.authenticate(req, res);
        const session = this.#own(user, req.params.id);
        session.seen = this.now();
        const take = () => {
            while (session.wanted.length) {
                const index = session.wanted.shift();
                if (!session.have.has(index)) return index;
            }
            return null;
        };
        let index = take();
        if (index === null) {
            index = await new Promise((resolve) => {
                const poller = { resolve };
                poller.timer = setTimeout(() => {
                    session.pollers = session.pollers.filter(
                        (p) => p !== poller,
                    );
                    resolve(null);
                }, this.limits.pollMs);
                session.pollers.push(poller);
            });
        }
        return { index };
    }

    async putChunk(req, res) {
        const { user } = await this.authenticate(req, res);
        const session = this.#own(user, req.params.id);
        const index = Number(req.params.index);
        if (!Number.isInteger(index) || index < 0 || index >= session.chunks)
            throw new HttpError(400, "bad_chunk");
        if (req.raw.length !== this.#chunkSize(session, index))
            throw new HttpError(400, "bad_chunk");
        const disk = await statfs(this.dir).catch(() => null);
        if (
            disk &&
            disk.bavail * disk.bsize < this.limits.diskReserve + req.raw.length
        )
            throw new HttpError(507, "disk_full");
        if (session.closed) throw new HttpError(404, "play_not_found");
        session.seen = this.now();
        await writeFile(this.#path(session.id, index), req.raw, {
            mode: 0o600,
        });
        if (session.closed) {
            // closed while writing: the write may have landed in a directory
            // the close had just emptied
            await rm(join(this.dir, session.id), {
                recursive: true,
                force: true,
            });
            throw new HttpError(404, "play_not_found");
        }
        session.have.set(index, { bytes: req.raw.length, used: this.now() });
        const entry = session.pending.get(index);
        session.pending.delete(index);
        for (const waiter of entry?.waiters ?? []) waiter.resolve();
        await this.#evict(session);
        return { ok: true };
    }

    /** The tab could not read a chunk from Telegram. */
    async fail(req, res) {
        const { user } = await this.authenticate(req, res);
        const session = this.#own(user, req.params.id);
        const index = Number(req.body.index);
        const entry = session.pending.get(index);
        session.pending.delete(index);
        for (const waiter of entry?.waiters ?? [])
            waiter.reject(new Error("unreadable"));
        return { ok: true };
    }

    async close(req, res) {
        const { user } = await this.authenticate(req, res);
        this.#own(user, req.params.id);
        await this.#drop(req.params.id);
        return { ok: true };
    }

    // ----- the player's side ------------------------------------------------

    /** Public: whoever holds the token. Answers one Range request. */
    open(req) {
        const session = this.#session(
            idRe.test(req.params.id) ? req.params.id : "",
        );
        session.played = this.now();
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
            if (start > end || start >= total)
                throw new HttpError(416, "bad_range");
        }
        return new PlayReply((res, head) =>
            this.#send(session, start, end, status, res, head),
        );
    }

    async #send(session, start, end, status, res, head) {
        res.writeHead(status, {
            "Content-Type": session.type,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            ...(status === 206
                ? { "Content-Range": `bytes ${start}-${end}/${session.size}` }
                : {}),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            // nginx must not read ahead of the player: the cache is the buffer
            "X-Accel-Buffering": "no",
        });
        if (head) return res.end();
        let closed = false;
        res.on("close", () => (closed = true));
        try {
            for (let at = start; at <= end && !closed && !session.closed; ) {
                const index = Math.floor(at / PLAY_CHUNK);
                session.at = index;
                session.played = this.now();
                this.#readAhead(session, index);
                await this.#ensure(session, index, true);
                const bytes = await this.#read(session, index);
                if (closed) return undefined;
                const from = at - index * PLAY_CHUNK;
                const piece = bytes.subarray(
                    from,
                    Math.min(bytes.length, end - index * PLAY_CHUNK + 1),
                );
                if (!piece.length) throw new Error("empty");
                if (!res.write(piece))
                    await new Promise((resolve) => res.once("drain", resolve));
                at += piece.length;
            }
            if (session.closed) res.destroy();
            else res.end();
        } catch {
            // the tab is gone or could not read: the player sees a cut stream
            res.destroy();
        }
        return undefined;
    }

    async #read(session, index) {
        for (let tries = 0; ; tries += 1) {
            try {
                const bytes = await readFile(this.#path(session.id, index));
                const kept = session.have.get(index);
                if (kept) kept.used = this.now();
                return bytes;
            } catch (error) {
                // evicted between the check and the read: ask again, once
                if (error.code !== "ENOENT" || tries > 0) throw error;
                session.have.delete(index);
                await this.#ensure(session, index, true);
            }
        }
    }

    // ----- asking the tab ---------------------------------------------------

    #want(session, index, urgent) {
        const at = session.wanted.indexOf(index);
        if (at >= 0) session.wanted.splice(at, 1);
        if (urgent) session.wanted.unshift(index);
        else session.wanted.push(index);
        // hand it to a waiting poll
        while (session.wanted.length && session.pollers.length) {
            const poller = session.pollers.shift();
            clearTimeout(poller.timer);
            poller.resolve(session.wanted.shift());
        }
    }

    /** Resolves when chunk `index` is here; urgent ones have a player waiting. */
    #ensure(session, index, urgent) {
        if (session.have.has(index)) return Promise.resolve();
        let entry = session.pending.get(index);
        if (!entry) {
            entry = { since: 0, waiters: new Set() };
            session.pending.set(index, entry);
        }
        // not asked yet, or asked and never answered (a poll that died)
        if (this.now() - entry.since > this.limits.waitMs) {
            entry.since = this.now();
            this.#want(session, index, urgent);
        } else if (urgent) {
            const at = session.wanted.indexOf(index);
            if (at > 0) this.#want(session, index, true);
        }
        if (!urgent) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            const timer = setTimeout(() => {
                entry.waiters.delete(waiter);
                reject(new Error("the tab did not answer"));
            }, this.limits.waitMs);
            entry.waiters.add(waiter);
        });
    }

    #readAhead(session, index) {
        const last = Math.min(session.chunks - 1, index + this.limits.ahead);
        for (let i = index + 1; i <= last; i += 1)
            if (!session.have.has(i)) this.#ensure(session, i, false);
    }

    // ----- housekeeping -----------------------------------------------------

    /** Keep the cache within its caps, dropping what was used longest ago. */
    async #evict(session) {
        const bytes = (s) =>
            [...s.have.values()].reduce((sum, c) => sum + c.bytes, 0);
        const spared = (s, index) =>
            index >= s.at && index <= s.at + this.limits.ahead;
        const oldest = (sessions) => {
            let found = null;
            for (const s of sessions)
                for (const [index, chunk] of s.have)
                    if (
                        !spared(s, index) &&
                        (!found || chunk.used < found.chunk.used)
                    )
                        found = { s, index, chunk };
            return found;
        };
        const drop = async ({ s, index }) => {
            s.have.delete(index);
            await rm(this.#path(s.id, index), { force: true });
        };
        let victim;
        while (
            bytes(session) > this.limits.sessionBytes &&
            (victim = oldest([session]))
        )
            await drop(victim);
        const all = [...this.sessions.values()];
        while (
            all.reduce((sum, s) => sum + bytes(s), 0) >
                this.limits.totalBytes &&
            (victim = oldest(all))
        )
            await drop(victim);
    }

    async #drop(id) {
        const session = this.sessions.get(id);
        if (!session) return;
        session.closed = true;
        this.sessions.delete(id);
        for (const poller of session.pollers.splice(0)) {
            clearTimeout(poller.timer);
            poller.resolve(null);
        }
        for (const entry of session.pending.values())
            for (const waiter of entry.waiters)
                waiter.reject(new Error("closed"));
        session.pending.clear();
        await rm(join(this.dir, id), { recursive: true, force: true });
    }

    async dropOwner(username) {
        for (const session of [...this.sessions.values()])
            if (session.owner === username) await this.#drop(session.id);
    }

    async sweep() {
        const now = this.now();
        for (const session of [...this.sessions.values()])
            if (
                now - Math.max(session.seen, session.played) >
                    this.limits.silentMs ||
                now - session.created > this.limits.maxMs
            )
                await this.#drop(session.id);
    }
}

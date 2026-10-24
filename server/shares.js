/**
 * Public share links.
 *
 * The bytes of a file live in its owner's Telegram account, which nobody else
 * can reach and this server cannot log in to. So sharing a file puts a second,
 * encrypted copy here: the browser picks a random key, encrypts the file in
 * chunks and uploads them, and the key travels only in the link's #fragment,
 * which browsers never send to a server. What is stored here is ciphertext
 * plus an encrypted name; without the link it is noise.
 *
 * A link either lives until its owner removes it, or expires after a number of
 * days, after which the sweep deletes the copy for good.
 *
 *     db.json  shares[id]          owner, sizes, expiry, encrypted meta
 *     shares/<id>/<n>.bin          one encrypted chunk each
 */
import { randomBytes } from "node:crypto";
import { statfs } from "node:fs/promises";

import { HttpError } from "./app.js";

const DAY = 24 * 60 * 60 * 1000;
// plaintext chunk size; each stored chunk is 16 bytes longer (the GCM tag)
export const SHARE_CHUNK = 8 * 1024 * 1024;
export const SHARE_LIMITS = {
    chunkBytes: SHARE_CHUNK + 16,
    fileBytes: 2 * 1024 * 1024 * 1024,
    sharesPerUser: 500,
    maxDays: 3650,
    // an upload abandoned halfway is swept after this long
    incompleteTtl: DAY,
    // keep this much disk free for the rest of the VPS
    diskReserve: 1024 * 1024 * 1024,
};

const idRe = /^[A-Za-z0-9_-]{22}$/;
const b64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** What a GET handler returns to stream a file instead of JSON. */
export class FileReply {
    constructor(path, size) {
        this.path = path;
        this.size = size;
    }
}

/** Fixed-window counter per key, like the login limiter. */
class Window {
    constructor(limit, windowMs) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.hits = new Map();
    }

    take(key, now) {
        const entry = this.hits.get(key);
        if (!entry || entry.reset <= now) {
            this.hits.set(key, { count: 1, reset: now + this.windowMs });
            return;
        }
        entry.count += 1;
        if (entry.count > this.limit) {
            throw new HttpError(429, "rate_limited", {
                retryAfter: Math.ceil((entry.reset - now) / 1000),
            });
        }
    }

    sweep(now) {
        for (const [key, entry] of this.hits) {
            if (entry.reset <= now) this.hits.delete(key);
        }
    }
}

export class Shares {
    constructor({ db, authenticate, now, quota }) {
        this.db = db;
        this.authenticate = authenticate;
        this.now = now;
        this.quota = quota;
        this.metaByIp = new Window(300, 15 * 60 * 1000);
        this.chunkByIp = new Window(3000, 15 * 60 * 1000);
    }

    get #all() {
        return this.db.data.shares;
    }

    #id(value) {
        if (typeof value !== "string" || !idRe.test(value))
            throw new HttpError(404, "share_not_found");
        return value;
    }

    #own(user, id) {
        const share = this.#all[this.#id(id)];
        if (!share || share.owner !== user.username)
            throw new HttpError(404, "share_not_found");
        return share;
    }

    #live(id) {
        const share = this.#all[this.#id(id)];
        if (
            !share ||
            !share.complete ||
            (share.expiresAt && share.expiresAt <= this.now())
        ) {
            throw new HttpError(404, "share_not_found");
        }
        return share;
    }

    #view(id, share) {
        return {
            id,
            createdAt: share.createdAt,
            expiresAt: share.expiresAt,
            bytes: share.bytes,
            complete: share.complete,
        };
    }

    // ----- owner side -------------------------------------------------------

    /**
     * Reserve a share before its chunks arrive. `bytes` is the plaintext size,
     * which only sizes the reservation; the real size is inside the encrypted
     * meta, and the reader checks it.
     */
    async create(req, res) {
        const { user } = await this.authenticate(req, res);
        const bytes = Number(req.body.bytes);
        if (
            !Number.isInteger(bytes) ||
            bytes < 0 ||
            bytes > SHARE_LIMITS.fileBytes
        ) {
            throw new HttpError(400, "bad_size", {
                max: SHARE_LIMITS.fileBytes,
            });
        }
        const days = req.body.days;
        if (
            days !== null &&
            (!Number.isInteger(days) || days < 1 || days > SHARE_LIMITS.maxDays)
        ) {
            throw new HttpError(400, "bad_expiry");
        }
        const meta = req.body.meta;
        if (
            typeof meta?.iv !== "string" ||
            typeof meta?.ct !== "string" ||
            !b64.test(meta.iv) ||
            !b64.test(meta.ct) ||
            meta.ct.length > 8192
        ) {
            throw new HttpError(400, "bad_meta");
        }

        const mine = Object.values(this.#all).filter(
            (s) => s.owner === user.username,
        );
        if (mine.length >= SHARE_LIMITS.sharesPerUser)
            throw new HttpError(409, "too_many_shares");
        const used = mine.reduce((sum, s) => sum + s.bytes, 0);
        if (used + bytes > this.quota)
            throw new HttpError(409, "share_quota", {
                quota: this.quota,
                used,
            });
        const disk = await statfs(this.db.dir).catch(() => null);
        if (
            disk &&
            disk.bavail * disk.bsize < bytes + SHARE_LIMITS.diskReserve
        ) {
            throw new HttpError(507, "disk_full");
        }

        const id = randomBytes(16).toString("base64url");
        this.#all[id] = {
            owner: user.username,
            createdAt: this.now(),
            expiresAt: days === null ? null : this.now() + days * DAY,
            bytes,
            chunks: Math.max(1, Math.ceil(bytes / SHARE_CHUNK)),
            meta: { iv: meta.iv, ct: meta.ct },
            complete: false,
        };
        await this.db.save();
        return { id, chunkSize: SHARE_CHUNK, chunks: this.#all[id].chunks };
    }

    async putChunk(req, res) {
        const { user } = await this.authenticate(req, res);
        const share = this.#own(user, req.params.id);
        const index = Number(req.params.index);
        if (share.complete) throw new HttpError(409, "share_complete");
        if (!Number.isInteger(index) || index < 0 || index >= share.chunks)
            throw new HttpError(400, "bad_chunk");
        if (req.raw.length < 16 || req.raw.length > SHARE_LIMITS.chunkBytes)
            throw new HttpError(400, "bad_chunk");
        await this.db.writeChunk(req.params.id, index, req.raw);
        return { ok: true };
    }

    async complete(req, res) {
        const { user } = await this.authenticate(req, res);
        const share = this.#own(user, req.params.id);
        for (let i = 0; i < share.chunks; i += 1) {
            if (!(await this.db.chunkSize(req.params.id, i)))
                throw new HttpError(409, "chunk_missing", { index: i });
        }
        share.complete = true;
        await this.db.save();
        return this.#view(req.params.id, share);
    }

    async list(req, res) {
        const { user } = await this.authenticate(req, res);
        return {
            shares: Object.entries(this.#all)
                .filter(([, s]) => s.owner === user.username)
                .map(([id, s]) => this.#view(id, s)),
        };
    }

    async remove(req, res) {
        const { user } = await this.authenticate(req, res);
        this.#own(user, req.params.id);
        await this.#drop(req.params.id);
        return { ok: true };
    }

    // ----- public side ------------------------------------------------------

    publicMeta(req) {
        this.metaByIp.take(req.ip, this.now());
        const share = this.#live(req.params.id);
        return {
            meta: share.meta,
            chunks: share.chunks,
            createdAt: share.createdAt,
            expiresAt: share.expiresAt,
        };
    }

    async publicChunk(req) {
        this.chunkByIp.take(req.ip, this.now());
        const share = this.#live(req.params.id);
        const index = Number(req.params.index);
        if (!Number.isInteger(index) || index < 0 || index >= share.chunks)
            throw new HttpError(404, "share_not_found");
        const size = await this.db.chunkSize(req.params.id, index);
        if (!size) throw new HttpError(404, "share_not_found");
        return new FileReply(this.db.chunkPath(req.params.id, index), size);
    }

    // ----- housekeeping -----------------------------------------------------

    async #drop(id) {
        delete this.#all[id];
        await this.db.save();
        await this.db.deleteShare(id);
    }

    async dropOwner(username) {
        for (const [id, share] of Object.entries(this.#all)) {
            if (share.owner === username) await this.#drop(id);
        }
    }

    async sweep() {
        const now = this.now();
        this.metaByIp.sweep(now);
        this.chunkByIp.sweep(now);
        for (const [id, share] of Object.entries(this.#all)) {
            const expired = share.expiresAt && share.expiresAt <= now;
            const abandoned =
                !share.complete &&
                share.createdAt + SHARE_LIMITS.incompleteTtl <= now;
            if (expired || abandoned) await this.#drop(id);
        }
    }
}

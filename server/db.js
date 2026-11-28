/**
 * Flat-file storage for a service with a handful of accounts.
 *
 * Everything the server knows lives under DATA_DIR:
 *
 *     db.json            accounts, login sessions, share links
 *     trees/<id>.json    one encrypted file tree per account
 *     shares/<id>/       the encrypted chunks of one shared file
 *
 * The trees sit apart because they are the only thing that grows, and the only
 * thing written on every upload; rewriting db.json each time would be wasteful.
 *
 * Every write goes to a temp file first and is then renamed over the original,
 * so a crash mid-write leaves the previous version intact instead of half a
 * JSON document.
 */
import {
    mkdir,
    open,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";

export class Db {
    constructor(dir) {
        this.dir = dir;
        this.file = join(dir, "db.json");
        this.data = { users: {}, sessions: {}, shares: {} };
        // writes are chained so two requests never rename over each other
        this.queue = Promise.resolve();
    }

    async open() {
        await mkdir(join(this.dir, "trees"), { recursive: true, mode: 0o700 });
        await mkdir(join(this.dir, "shares"), { recursive: true, mode: 0o700 });
        try {
            this.data = JSON.parse(await readFile(this.file, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await this.save();
        }
        this.data.users ??= {};
        this.data.sessions ??= {};
        this.data.shares ??= {};
        return this;
    }

    save() {
        return this.#write(this.file, JSON.stringify(this.data, null, 2));
    }

    #write(path, text) {
        const run = async () => {
            const temp = `${path}.${process.pid}.tmp`;
            if (Array.isArray(text)) {
                const file = await open(temp, "w", 0o600);
                try {
                    for (const part of text)
                        for (let i = 0; i < part.length; i += 65536)
                            await file.writeFile(part.slice(i, i + 65536));
                } finally {
                    await file.close();
                }
            } else await writeFile(temp, text, { mode: 0o600 });
            await rename(temp, path);
        };
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => {});
        return next;
    }

    #treePath(userId) {
        // ids are generated here (hex), never taken from a request
        if (!/^[0-9a-f]{32}$/.test(userId)) throw new Error("bad user id");
        return join(this.dir, "trees", `${userId}.json`);
    }

    async readTree(userId) {
        try {
            return JSON.parse(await readFile(this.#treePath(userId), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }

    writeTree(userId, tree) {
        return this.#write(this.#treePath(userId), JSON.stringify(tree));
    }

    async deleteTree(userId) {
        await rm(this.#treePath(userId), { force: true });
        await rm(this.#shardDir(userId), { recursive: true, force: true });
    }

    // A sharded tree: trees/<id>/meta.json says which version each shard was
    // last written at; trees/<id>/<n>-<version>.json holds one shard's blob.
    #shardDir(userId) {
        this.#treePath(userId);
        return join(this.dir, "trees", userId);
    }

    async readTreeMeta(userId) {
        try {
            return JSON.parse(
                await readFile(
                    join(this.#shardDir(userId), "meta.json"),
                    "utf8",
                ),
            );
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }

    shardPath(userId, n, version) {
        if (!Number.isInteger(n) || n < 0) throw new Error("bad shard");
        if (!Number.isSafeInteger(version) || version < 1)
            throw new Error("bad version");
        return join(this.#shardDir(userId), `${n}-${version}.json`);
    }

    async readShard(userId, n, version) {
        return JSON.parse(
            await readFile(this.shardPath(userId, n, version), "utf8"),
        );
    }

    streamShard(userId, n, version) {
        return createReadStream(this.shardPath(userId, n, version));
    }

    /**
     * Versioned shards first, then the meta that points at them. A crash
     * before the meta write leaves the previous tree intact.
     */
    async writeShards(userId, shards, meta, previous) {
        const dir = this.#shardDir(userId);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        for (const [n, blob] of Object.entries(shards))
            await this.#write(join(dir, `${Number(n)}-${meta.version}.json`), [
                '{"iv":"',
                blob.iv,
                '","ct":"',
                blob.ct,
                '"}',
            ]);
        await this.#write(join(dir, "meta.json"), JSON.stringify(meta));
        for (const n of Object.keys(shards)) {
            const old = previous?.shards[n];
            if (old)
                await rm(join(dir, `${Number(n)}-${old}.json`), {
                    force: true,
                });
        }
    }

    async dropLegacyTree(userId) {
        await rm(this.#treePath(userId), { force: true });
    }

    #shareDir(id) {
        // share ids are generated here (base64url), and checked again by the
        // caller before they reach a path
        if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new Error("bad share id");
        return join(this.dir, "shares", id);
    }

    chunkPath(id, index) {
        if (!Number.isInteger(index) || index < 0) throw new Error("bad chunk");
        return join(this.#shareDir(id), `${index}.bin`);
    }

    async writeChunk(id, index, bytes) {
        await mkdir(this.#shareDir(id), { recursive: true, mode: 0o700 });
        const path = this.chunkPath(id, index);
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, path);
    }

    /** Byte size of a stored chunk, or 0 when it is not there. */
    async chunkSize(id, index) {
        try {
            return (await stat(this.chunkPath(id, index))).size;
        } catch (error) {
            if (error.code === "ENOENT") return 0;
            throw error;
        }
    }

    async deleteShare(id) {
        await rm(this.#shareDir(id), { recursive: true, force: true });
    }
}

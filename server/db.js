/**
 * Flat-file storage for a service with a handful of accounts.
 *
 * Everything the server knows lives under DATA_DIR:
 *
 *     db.json            accounts, login sessions
 *     trees/<id>.json    one encrypted file tree per account
 *
 * The trees sit apart because they are the only thing that grows, and the only
 * thing written on every upload; rewriting db.json each time would be wasteful.
 *
 * Every write goes to a temp file first and is then renamed over the original,
 * so a crash mid-write leaves the previous version intact instead of half a
 * JSON document.
 */
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export class Db {
    constructor(dir) {
        this.dir = dir;
        this.file = join(dir, "db.json");
        this.data = { users: {}, sessions: {} };
        // writes are chained so two requests never rename over each other
        this.queue = Promise.resolve();
    }

    async open() {
        await mkdir(join(this.dir, "trees"), { recursive: true, mode: 0o700 });
        try {
            this.data = JSON.parse(await readFile(this.file, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await this.save();
        }
        this.data.users ??= {};
        this.data.sessions ??= {};
        return this;
    }

    save() {
        return this.#write(this.file, JSON.stringify(this.data, null, 2));
    }

    #write(path, text) {
        const run = async () => {
            const temp = `${path}.${process.pid}.tmp`;
            await writeFile(temp, text, { mode: 0o600 });
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
    }
}

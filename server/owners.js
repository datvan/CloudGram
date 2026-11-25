import { createHash, randomBytes } from "node:crypto";
import {
    mkdir,
    readdir,
    readFile,
    rename,
    writeFile,
    rm,
} from "node:fs/promises";
import { join } from "node:path";

const key = (username) => createHash("sha256").update(username).digest("hex");
const validId = (id) => Number.isSafeInteger(id) && id > 0;

export class Owners {
    constructor(dataDir) {
        this.dir = join(dataDir, "owners");
        this.accounts = new Map();
        this.reverse = new Map();
        this.queue = Promise.resolve();
    }

    async open(users) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const files = await readdir(this.dir);
        for (const user of Object.values(users ?? {})) {
            const old = `${key(user.username)}.json`;
            const target = `${key(user.id)}.json`;
            if (!files.includes(old) || old === target) continue;
            if (files.includes(target))
                throw new Error("ownership ledger migration conflict");
            await rename(join(this.dir, old), join(this.dir, target));
        }
        for (const file of await readdir(this.dir)) {
            if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
            const account = file.slice(0, 64);
            if (
                users &&
                !Object.values(users ?? {}).some((u) => key(u.id) === account)
            ) {
                console.log(JSON.stringify({ src: "tgx", unmatched: file }));
                continue;
            }
            const data = JSON.parse(
                await readFile(join(this.dir, file), "utf8"),
            );
            if (data.v !== 1 || !Array.isArray(data.ids))
                throw new Error("bad ownership ledger");
            const ids = new Set();
            for (const id of data.ids) {
                if (!validId(id) || this.reverse.has(id))
                    throw new Error("duplicate or invalid owner");
                ids.add(id);
                this.reverse.set(id, account);
            }
            this.accounts.set(account, ids);
        }
        return this;
    }

    owns(username, id) {
        return this.reverse.get(id) === key(username);
    }
    filterOwned(username, ids) {
        return ids.filter((id) => this.owns(username, id));
    }
    count(username) {
        return this.accounts.get(key(username))?.size ?? 0;
    }

    #change(username, change) {
        const account = key(username);
        const run = async () => {
            const ids = new Set(this.accounts.get(account) ?? []);
            change(ids, account);
            const path = join(this.dir, `${account}.json`);
            const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
            try {
                await writeFile(temp, JSON.stringify({ v: 1, ids: [...ids] }), {
                    mode: 0o600,
                    flag: "wx",
                });
                await rename(temp, path);
            } finally {
                await rm(temp, { force: true });
            }
            for (const id of this.accounts.get(account) ?? [])
                this.reverse.delete(id);
            for (const id of ids) this.reverse.set(id, account);
            this.accounts.set(account, ids);
        };
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => {});
        return next;
    }

    add(username, id) {
        if (!validId(id)) throw new Error("bad message id");
        return this.#change(username, (ids, account) => {
            if (this.reverse.has(id) && this.reverse.get(id) !== account)
                throw new Error("message already owned");
            ids.add(id);
        });
    }
    remove(username, ids) {
        return this.#change(username, (owned) => {
            for (const id of ids) owned.delete(id);
        });
    }
    drop(user) {
        const account = key(user);
        const run = async () => {
            const ids = this.accounts.get(account) ?? new Set();
            await rm(join(this.dir, `${account}.json`), { force: true });
            for (const id of ids) this.reverse.delete(id);
            this.accounts.delete(account);
            console.log(JSON.stringify({ src: "tgx", dropped: ids.size }));
        };
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => {});
        return next;
    }
}

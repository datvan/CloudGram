import { join } from "node:path";
import { stat } from "node:fs/promises";
import { HttpError } from "./app.js";

export class Thumbs {
    constructor(dir, { load = () => import("node:sqlite") } = {}) {
        this.path = join(dir, "thumbs.sqlite");
        this.load = load;
    }

    async open() {
        if (!this.opening)
            this.opening = this.load()
                .catch(() => {
                    throw new HttpError(503, "thumbs_unavailable");
                })
                .then(({ DatabaseSync }) => {
                    const db = new DatabaseSync(this.path);
                    db.exec(
                        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS thumbs (user_id TEXT NOT NULL, thumb_id TEXT NOT NULL, iv TEXT NOT NULL, ct BLOB NOT NULL, bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, thumb_id)) WITHOUT ROWID",
                    );
                    return db;
                });
        return this.opening;
    }

    async put(userId, entries, limits, now) {
        const db = await this.open();
        db.exec("BEGIN IMMEDIATE");
        try {
            const total = db
                .prepare(
                    "SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM thumbs WHERE user_id = ?",
                )
                .get(userId);
            const previous = db.prepare(
                "SELECT bytes FROM thumbs WHERE user_id = ? AND thumb_id = ?",
            );
            let { count, bytes } = total;
            for (const [id, blob] of entries) {
                const old = previous.get(userId, id);
                if (!old) count++;
                bytes += blob.ct.length - (old?.bytes ?? 0);
            }
            if (count > limits.count || bytes > limits.bytes) {
                db.exec("ROLLBACK");
                return false;
            }
            const write = db.prepare(
                "INSERT INTO thumbs VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, thumb_id) DO UPDATE SET iv=excluded.iv, ct=excluded.ct, bytes=excluded.bytes, updated_at=excluded.updated_at",
            );
            for (const [id, blob] of entries)
                write.run(userId, id, blob.iv, blob.ct, blob.ct.length, now);
            db.exec("COMMIT");
            return true;
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }

    async get(userId, ids, maxBytes) {
        const db = await this.open();
        const read = db.prepare(
            "SELECT iv, ct FROM thumbs WHERE user_id = ? AND thumb_id = ?",
        );
        const thumbs = Object.create(null);
        let size = Buffer.byteLength(JSON.stringify({ thumbs, more: true }));
        let more = false;
        let count = 0;
        for (const id of new Set(ids)) {
            const row = read.get(userId, id);
            if (!row) continue;
            const blob = {
                iv: row.iv,
                ct: Buffer.from(row.ct).toString("base64"),
            };
            const added =
                Buffer.byteLength(JSON.stringify(id)) +
                1 +
                Buffer.byteLength(JSON.stringify(blob)) +
                (count ? 1 : 0);
            if (size + added > maxBytes) {
                more = true;
                break;
            }
            thumbs[id] = blob;
            count++;
            size += added;
        }
        return more ? { thumbs, more } : { thumbs };
    }

    async delete(userId, ids) {
        const db = await this.open();
        const remove = db.prepare(
            "DELETE FROM thumbs WHERE user_id = ? AND thumb_id = ?",
        );
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const id of new Set(ids)) remove.run(userId, id);
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }

    async deleteUser(userId) {
        if (!this.opening) {
            try {
                await stat(this.path);
            } catch (error) {
                if (error.code === "ENOENT") return;
                throw error;
            }
        }
        let db;
        try {
            db = await this.open();
        } catch (error) {
            if (
                error instanceof HttpError &&
                error.status === 503 &&
                error.code === "thumbs_unavailable"
            )
                return;
            throw error;
        }
        db.prepare("DELETE FROM thumbs WHERE user_id = ?").run(userId);
    }

    async backup(dest) {
        (await this.open()).prepare("VACUUM INTO ?").run(dest);
    }
}

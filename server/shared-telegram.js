import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class SharedTelegram {
    constructor(dir, env = process.env) {
        this.file = join(dir, "telegram-root.json");
        this.env = env;
        this.enabled = env.CLOUDGRAM_SHARED_TELEGRAM !== "0";
        this.queue = Promise.resolve();
    }

    key() {
        const value = this.env.CLOUDGRAM_TG_ROOT_KEY || "";
        const key = Buffer.from(value, "base64");
        if (key.length !== 32 || key.toString("base64") !== value)
            throw new Error(
                "CLOUDGRAM_TG_ROOT_KEY must be a 32-byte base64 key",
            );
        return key;
    }

    async load() {
        let data;
        try {
            data = JSON.parse(await readFile(this.file, "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        const decipher = createDecipheriv(
            "aes-256-gcm",
            this.key(),
            Buffer.from(data.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(data.tag, "base64"));
        return Buffer.concat([
            decipher.update(Buffer.from(data.ciphertext, "base64")),
            decipher.final(),
        ]).toString("utf8");
    }

    async save(session) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
        const ciphertext = Buffer.concat([
            cipher.update(session, "utf8"),
            cipher.final(),
        ]);
        const temp = `${this.file}.${process.pid}.tmp`;
        await writeFile(
            temp,
            JSON.stringify({
                iv: iv.toString("base64"),
                tag: cipher.getAuthTag().toString("base64"),
                ciphertext: ciphertext.toString("base64"),
            }),
            { mode: 0o600 },
        );
        await rename(temp, this.file);
    }

    async unlink() {
        await rm(this.file, { force: true });
    }

    async client(session) {
        const { TelegramClient } = await import("telegram");
        const { StringSession } = await import("telegram/sessions/index.js");
        const id = Number(this.env.CLOUDGRAM_TG_API_ID);
        const hash = this.env.CLOUDGRAM_TG_API_HASH;
        if (!Number.isSafeInteger(id) || id <= 0 || !hash)
            throw new Error("Telegram API credentials required");
        return new TelegramClient(new StringSession(session), id, hash, {
            connectionRetries: 5,
        });
    }

    approve(token) {
        const next = this.queue.then(() => this.accept(token));
        this.queue = next.catch(() => {});
        return next;
    }

    async accept(token) {
        const session = await this.load();
        if (!session) return false;
        const client = await this.client(session);
        try {
            const { Api } = await import("telegram");
            await client.connect();
            await client.invoke(new Api.auth.AcceptLoginToken({ token }));
            const updated = client.session.save();
            if (updated !== session) await this.save(updated);
            return true;
        } finally {
            await client.destroy();
        }
    }
}

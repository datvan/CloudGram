import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class SharedTelegram {
    constructor(dir, env = process.env) {
        this.file = join(dir, "telegram-root.json");
        this.passwordFile = join(dir, "telegram-2fa.json");
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

    async savePassword(password, invalid = false) {
        if (typeof password !== "string" || !password)
            throw new Error("telegram_password_missing");
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify({ password, invalid }), "utf8"),
            cipher.final(),
        ]);
        const temp = `${this.passwordFile}.${randomBytes(12).toString("hex")}.tmp`;
        try {
            await writeFile(
                temp,
                JSON.stringify({
                    iv: iv.toString("base64"),
                    tag: cipher.getAuthTag().toString("base64"),
                    ciphertext: ciphertext.toString("base64"),
                }),
                { mode: 0o600 },
            );
            await rename(temp, this.passwordFile);
        } finally {
            await rm(temp, { force: true });
        }
    }

    async loadPassword() {
        let data;
        try {
            data = JSON.parse(await readFile(this.passwordFile, "utf8"));
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
        return JSON.parse(
            Buffer.concat([
                decipher.update(Buffer.from(data.ciphertext, "base64")),
                decipher.final(),
            ]).toString("utf8"),
        );
    }

    async clearPassword() {
        await rm(this.passwordFile, { force: true });
    }

    async telegramApi() {
        return (await import("telegram")).Api;
    }

    async passwordCheck(parameters, password) {
        const { computeCheck } = await import("telegram/Password.js");
        return computeCheck(parameters, password);
    }

    issue() {
        const next = this.queue.then(() => this.#issue());
        this.queue = next.catch(() => {});
        return next;
    }

    async #issue() {
        let client;
        let authorized = false;
        let Api;
        const coded = (code) => Object.assign(new Error(code), { code });
        try {
            if (!(await this.load())) throw coded("telegram_not_linked");
            Api = await this.telegramApi();
            client = await this.client("");
            await client.connect();
            const exportToken = () =>
                client.invoke(
                    new Api.auth.ExportLoginToken({
                        apiId: Number(this.env.CLOUDGRAM_TG_API_ID),
                        apiHash: this.env.CLOUDGRAM_TG_API_HASH,
                        exceptIds: [],
                    }),
                );
            const first = await exportToken();
            if (!(first instanceof Api.auth.LoginToken))
                throw coded("telegram_issue_failed");
            if (!(await this.accept(first.token)))
                throw coded("telegram_not_linked");
            let result;
            try {
                result = await exportToken();
                if (result instanceof Api.auth.LoginTokenMigrateTo) {
                    await client._switchDC(result.dcId);
                    result = await client.invoke(
                        new Api.auth.ImportLoginToken({ token: result.token }),
                    );
                }
            } catch (error) {
                if (error.errorMessage !== "SESSION_PASSWORD_NEEDED")
                    throw error;
                const stored = await this.loadPassword();
                if (!stored) throw coded("telegram_password_missing");
                if (stored.invalid) throw coded("telegram_password_invalid");
                try {
                    const parameters = await client.invoke(
                        new Api.account.GetPassword(),
                    );
                    const password = await this.passwordCheck(
                        parameters,
                        stored.password,
                    );
                    result = await client.invoke(
                        new Api.auth.CheckPassword({ password }),
                    );
                    authorized = true;
                    if (result instanceof Api.auth.LoginTokenMigrateTo) {
                        await client._switchDC(result.dcId);
                        result = await client.invoke(
                            new Api.auth.ImportLoginToken({
                                token: result.token,
                            }),
                        );
                        if (!(result instanceof Api.auth.LoginTokenSuccess))
                            throw coded("telegram_issue_failed");
                    }
                } catch (passwordError) {
                    if (passwordError.errorMessage !== "PASSWORD_HASH_INVALID")
                        throw passwordError;
                    const current = await this.loadPassword();
                    if (
                        current?.password === stored.password &&
                        current.invalid === false
                    )
                        await this.savePassword(stored.password, true);
                    throw coded("telegram_password_invalid");
                }
            }
            if (!authorized && !(result instanceof Api.auth.LoginTokenSuccess))
                throw coded("telegram_issue_failed");
            authorized = true;
            return {
                session: client.session.save(),
                dcId: client.session.dcId,
            };
        } catch (error) {
            if (authorized && client && Api) {
                try {
                    await client.invoke(new Api.auth.LogOut());
                } catch {}
            }
            if (
                [
                    "telegram_not_linked",
                    "telegram_password_missing",
                    "telegram_password_invalid",
                    "telegram_issue_failed",
                ].includes(error.code)
            )
                throw coded(error.code);
            const match = /^FLOOD_WAIT_(\d+)$/.exec(error.errorMessage || "");
            if (
                match ||
                (Number.isFinite(error.seconds) && error.seconds > 0)
            ) {
                throw Object.assign(coded("telegram_busy"), {
                    seconds: Number.isFinite(error.seconds) && error.seconds > 0
                        ? error.seconds
                        : Number(match[1]),
                });
            }
            throw coded("telegram_issue_failed");
        } finally {
            if (client) {
                try {
                    await client.destroy();
                } catch {}
            }
        }
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
            const Api = await this.telegramApi();
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

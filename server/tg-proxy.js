import { randomBytes } from "node:crypto";
import bigInt from "big-integer";
import { Api } from "telegram";
import { HttpError } from "./app.js";

const PART = 524288;
const WINDOW = 1048576;
const ALIGN = 4096;
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const documentOf = (message) => message?.document ?? message?.media?.document;

function view(message) {
    if (!message || !documentOf(message)) return null;
    const doc = documentOf(message);
    const attrs = doc.attributes ?? [];
    const file = attrs.find((a) => a.className === "DocumentAttributeFilename");
    const video = attrs.find((a) => a.className === "DocumentAttributeVideo");
    return {
        id: message.id,
        date: message.date,
        size: Number(doc.size),
        name: file?.fileName ?? "",
        mime: doc.mimeType ?? "application/octet-stream",
        caption: message.message ?? "",
        hasThumb: !!doc.thumbs?.length,
        video: video
            ? { duration: video.duration, w: video.w, h: video.h }
            : null,
    };
}

export function gramTelegram(client) {
    return {
        async savePart(upload, index, bytes) {
            const fields = { fileId: upload.fileId, filePart: index, bytes };
            const request = upload.big
                ? new Api.upload.SaveBigFilePart({
                      ...fields,
                      fileTotalParts: upload.parts,
                  })
                : new Api.upload.SaveFilePart(fields);
            return client.invoke(request);
        },
        async send(upload, body) {
            // GramJS InputFile uses an empty checksum in client/uploads.js.
            const fields = {
                id: upload.fileId,
                parts: upload.parts,
                name: body.name,
            };
            const file = upload.big
                ? new Api.InputFileBig(fields)
                : new Api.InputFile({ ...fields, md5Checksum: "" });
            const attributes = [
                new Api.DocumentAttributeFilename({ fileName: body.name }),
            ];
            if (body.video)
                attributes.push(new Api.DocumentAttributeVideo(body.video));
            // sendFile does not forward mimeType; InputMediaUploadedDocument carries it.
            const media = new Api.InputMediaUploadedDocument({
                file,
                mimeType: body.mime,
                attributes,
                forceFile: body.forceDocument === true,
            });
            return client.sendFile("me", {
                file: media,
                caption: body.caption ?? "",
            });
        },
        getMessages(ids) {
            return client.getMessages("me", { ids });
        },
        deleteMessages(ids) {
            return client.deleteMessages("me", ids, { revoke: true });
        },
        async getFile(doc, offset, limit, thumbSize = "") {
            const location = new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
                thumbSize,
            });
            const result = await client.invoke(
                new Api.upload.GetFile({
                    location,
                    offset: bigInt(offset),
                    limit,
                    precise: true,
                }),
            );
            return result.bytes;
        },
    };
}

export class TelegramProxy {
    constructor({ owners, telegram, now = Date.now, limits = {} }) {
        this.owners = owners;
        const transport = telegram.savePart ? telegram : gramTelegram(telegram);
        this.telegram = Object.fromEntries(
            [
                "savePart",
                "send",
                "getMessages",
                "getFile",
                "deleteMessages",
            ].map((name) => [
                name,
                (...args) => this.#telegramCall(() => transport[name](...args)),
            ]),
        );
        this.now = now;
        this.limits = {
            uploads: 24,
            requests: 16,
            ttl: 6 * 60 * 60 * 1000,
            global: 24,
            queueWait: 30000,
            ...limits,
        };
        this.uploads = new Map();
        this.active = new Map();
        this.rates = new Map();
        this.telegramActive = 0;
        this.telegramQueue = [];
    }

    async #telegramCall(fn) {
        if (this.telegramActive >= this.limits.global) {
            await new Promise((resolve, reject) => {
                const entry = {
                    resolve,
                    timer: setTimeout(() => {
                        this.telegramQueue.splice(
                            this.telegramQueue.indexOf(entry),
                            1,
                        );
                        reject(new HttpError(503, "telegram_busy"));
                    }, this.limits.queueWait),
                };
                this.telegramQueue.push(entry);
            });
        } else this.telegramActive++;
        try {
            return await fn();
        } finally {
            const next = this.telegramQueue.shift();
            if (next) {
                clearTimeout(next.timer);
                next.resolve();
            } else this.telegramActive--;
        }
    }

    async #run(user, fn, part = false) {
        const now = this.now();
        let rate = this.rates.get(user);
        if (!rate || now - rate.start >= 10000) {
            for (const [account, value] of this.rates)
                if (now - value.start >= 10000) this.rates.delete(account);
            rate = { start: now, part: 0, other: 0 };
            this.rates.set(user, rate);
        }
        const kind = part ? "part" : "other";
        if (rate[kind] >= (part ? 64 : 200))
            throw new HttpError(429, "busy", {
                seconds: Math.max(
                    1,
                    Math.ceil((rate.start + 10000 - now) / 1000),
                ),
            });
        rate[kind]++;
        const active = this.active.get(user) ?? 0;
        if (active >= this.limits.requests)
            throw new HttpError(429, "busy", { seconds: 1 });
        this.active.set(user, active + 1);
        try {
            return await fn();
        } catch (error) {
            if (error instanceof HttpError) throw error;
            const match = String(
                error.errorMessage ?? error.message ?? "",
            ).match(/FLOOD(?:_WAIT)?_?(\d+)?/i);
            if (match)
                throw new HttpError(503, "telegram_busy", {
                    seconds: Number(error.seconds ?? match[1] ?? 0),
                });
            throw new HttpError(502, "telegram_failed");
        } finally {
            const left = this.active.get(user) - 1;
            if (left) this.active.set(user, left);
            else this.active.delete(user);
        }
    }
    #expire() {
        for (const [id, upload] of this.uploads)
            if (
                this.now() - upload.created >= this.limits.ttl &&
                !upload.locked
            )
                this.uploads.delete(id);
    }
    #upload(user, id) {
        this.#expire();
        const upload = this.uploads.get(id);
        if (!upload || upload.user !== user)
            throw new HttpError(404, "not_found");
        return upload;
    }
    #ids(ids) {
        if (!Array.isArray(ids) || ids.length > 100 || !ids.every(validId))
            throw new HttpError(400, "bad_batch");
    }
    async #message(id) {
        const messages = await this.telegram.getMessages([id]);
        return messages?.find((m) => m?.id === id) ?? null;
    }
    startUpload(user, body) {
        return this.#run(user, async () => {
            this.#expire();
            const { size, parts } = body ?? {};
            if (
                !Number.isSafeInteger(size) ||
                size < 1 ||
                size > 4000 * PART ||
                parts !== Math.ceil(size / PART)
            )
                throw new HttpError(400, "bad_size");
            if (
                [...this.uploads.values()].filter((u) => u.user === user)
                    .length >= this.limits.uploads
            )
                throw new HttpError(429, "busy", { seconds: 1 });
            const uploadId = randomBytes(16).toString("hex");
            const fileId = bigInt(randomBytes(8).toString("hex"), 16).subtract(
                bigInt(2).pow(63),
            );
            this.uploads.set(uploadId, {
                user,
                size,
                parts,
                fileId,
                big: size > 10 * 1024 * 1024,
                created: this.now(),
                done: new Set(),
                attempts: new Map(),
                locked: false,
                pending: 0,
            });
            return { uploadId };
        });
    }
    putPart(user, id, index, body) {
        return this.#run(
            user,
            async () => {
                const u = this.#upload(user, id);
                if (u.locked) throw new HttpError(409, "busy");
                if (!Number.isInteger(index) || index < 0 || index >= u.parts)
                    throw new HttpError(400, "bad_chunk");
                if ((u.attempts.get(index) ?? 0) >= 4)
                    throw new HttpError(409, "chunk_retry_limit");
                u.attempts.set(index, (u.attempts.get(index) ?? 0) + 1);
                u.pending++;
                try {
                    const bytes =
                        typeof body === "function" ? await body() : body;
                    if (
                        !Buffer.isBuffer(bytes) ||
                        bytes.length !== Math.min(PART, u.size - index * PART)
                    )
                        throw new HttpError(400, "bad_chunk");
                    if (!(await this.telegram.savePart(u, index, bytes)))
                        throw new Error("part rejected");
                    u.done.add(index);
                } finally {
                    u.pending--;
                }
                return { ok: true };
            },
            true,
        );
    }
    finishUpload(user, id, body) {
        return this.#run(user, async () => {
            const u = this.#upload(user, id);
            if (u.locked || u.pending) throw new HttpError(409, "busy");
            if (u.done.size !== u.parts)
                throw new HttpError(409, "chunk_missing");
            if (
                !body ||
                typeof body.name !== "string" ||
                !body.name ||
                typeof body.mime !== "string" ||
                !body.mime ||
                (body.caption !== undefined &&
                    typeof body.caption !== "string") ||
                (body.forceDocument !== undefined &&
                    typeof body.forceDocument !== "boolean") ||
                (body.video !== undefined &&
                    (!body.video ||
                        ![
                            body.video.duration,
                            body.video.w,
                            body.video.h,
                        ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
                        (body.video.supportsStreaming !== undefined &&
                            typeof body.video.supportsStreaming !== "boolean")))
            )
                throw new HttpError(400, "bad_meta");
            u.locked = true;
            try {
                const message = await this.telegram.send(u, body);
                if (!validId(message?.id) || !view(message))
                    throw new Error("bad Telegram message");
                // Never resend a message after Telegram accepted it, even if ledger persistence fails.
                this.uploads.delete(id);
                try {
                    await this.owners.add(user, message.id);
                } catch {
                    console.log(
                        JSON.stringify({ src: "tgx", orphan: message.id }),
                    );
                    throw new HttpError(500, "internal");
                }
                return { message: view(message) };
            } finally {
                u.locked = false;
            }
        });
    }
    cancelUpload(user, id) {
        return this.#run(user, async () => {
            const u = this.#upload(user, id);
            if (u.locked || u.pending) throw new HttpError(409, "busy");
            this.uploads.delete(id);
            return { ok: true };
        });
    }
    messages(user, ids) {
        return this.#run(user, async () => {
            this.#ids(ids);
            const owned = this.owners.filterOwned(user, ids);
            const found = owned.length
                ? await this.telegram.getMessages(owned)
                : [];
            const byId = new Map(
                found.filter(Boolean).map((m) => [m.id, view(m)]),
            );
            return {
                messages: ids.map((id) =>
                    this.owners.owns(user, id) ? (byId.get(id) ?? null) : null,
                ),
            };
        });
    }
    async #read(user, id, offset, limit, thumb) {
        if (!validId(id) || !this.owners.owns(user, id))
            throw new HttpError(404, "not_found");
        let message = await this.#message(id);
        let doc = documentOf(message);
        if (!doc) throw new HttpError(404, "not_found");
        let thumbSize = "";
        if (thumb) {
            const sizes = (doc.thumbs ?? []).filter(
                (t) => typeof t.type === "string",
            );
            const largest = sizes.reduce(
                (a, b) =>
                    !a || (b.w ?? 0) * (b.h ?? 0) > (a.w ?? 0) * (a.h ?? 0)
                        ? b
                        : a,
                null,
            );
            if (!largest) throw new HttpError(404, "not_found");
            thumbSize = largest.type;
        }
        const chunks = [];
        let pos = offset;
        const end = offset + limit;
        let refreshed = false;
        while (pos < end) {
            const start = Math.floor(pos / ALIGN) * ALIGN;
            const windowEnd = (Math.floor(start / WINDOW) + 1) * WINDOW;
            const takeEnd = Math.min(end, windowEnd);
            const requestLimit = Math.ceil((takeEnd - start) / ALIGN) * ALIGN;
            let bytes;
            try {
                bytes = Buffer.from(
                    await this.telegram.getFile(
                        doc,
                        start,
                        requestLimit,
                        thumbSize,
                    ),
                );
            } catch (error) {
                if (
                    !refreshed &&
                    /FILE_REFERENCE_EXPIRED/.test(
                        String(error.errorMessage ?? error.message),
                    )
                ) {
                    refreshed = true;
                    message = await this.#message(id);
                    doc = documentOf(message);
                    if (!doc) throw new HttpError(404, "not_found");
                    continue;
                }
                throw error;
            }
            const slice = bytes.subarray(pos - start, takeEnd - start);
            chunks.push(slice);
            pos += slice.length;
            if (bytes.length < requestLimit || !slice.length) break;
        }
        return Buffer.concat(chunks);
    }
    readFile(user, id, offset, limit) {
        return this.#run(user, async () => {
            if (
                !Number.isSafeInteger(offset) ||
                offset < 0 ||
                !Number.isSafeInteger(limit) ||
                limit < 1 ||
                limit > WINDOW ||
                !Number.isSafeInteger(offset + limit)
            )
                throw new HttpError(400, "bad_range");
            return this.#read(user, id, offset, limit, false);
        });
    }
    thumb(user, id) {
        return this.#run(user, () => this.#read(user, id, 0, WINDOW, true));
    }
    deleteMessages(user, ids) {
        return this.#run(user, async () => {
            this.#ids(ids);
            const owned = [...new Set(this.owners.filterOwned(user, ids))];
            if (owned.length) {
                await this.telegram.deleteMessages(owned);
                await this.owners.remove(user, owned);
            }
            return { deleted: owned };
        });
    }
}

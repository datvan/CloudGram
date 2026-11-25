import { Api } from "telegram";
import { Buffer } from "buffer/";
import * as proxy from "./tgProxy";

const PART = 512 * 1024;
const READ = 1024 * 1024;
const unavailable = () => {
    throw new Error("not available for this account");
};

function message(view) {
    if (!view) return undefined;
    const attributes = [
        new Api.DocumentAttributeFilename({ fileName: view.name }),
    ];
    if (view.video) attributes.push(new Api.DocumentAttributeVideo(view.video));
    return {
        id: view.id,
        date: view.date,
        message: view.caption,
        media: {
            document: {
                id: view.id,
                accessHash: 0,
                fileReference: Buffer.alloc(0),
                dcId: 0,
                size: view.size,
                mimeType: view.mime,
                attributes,
                thumbs: view.hasThumb ? [{ type: "m" }] : [],
            },
        },
    };
}

export function createProxyClient() {
    const controller = new AbortController();
    const disconnected = () => controller.signal.throwIfAborted();
    const client = {
        connected: true,
        session: { dcId: 0 },
        async proxyUpload(file, options = {}) {
            disconnected();
            const { stats } = options;
            const signal = options.signal
                ? AbortSignal.any([controller.signal, options.signal])
                : controller.signal;
            signal?.throwIfAborted();
            const parts = Math.ceil(file.size / PART);
            const { uploadId } = await proxy.startUpload(
                file.size,
                parts,
                signal,
            );
            let sent = 0;
            let next = 0;
            let failed = false;
            try {
                const worker = async () => {
                    while (next < parts && !failed) {
                        signal?.throwIfAborted();
                        const index = next;
                        next += 8;
                        const bytes = new Uint8Array(
                            await file
                                .slice(
                                    index * PART,
                                    Math.min(file.size, (index + 8) * PART),
                                )
                                .arrayBuffer(),
                        );
                        signal?.throwIfAborted();
                        let attempt = 0;
                        let rateWait = 0;
                        let rateRetries = 0;
                        for (;;) {
                            try {
                                await proxy.putPart(
                                    uploadId,
                                    index,
                                    bytes,
                                    signal,
                                );
                                break;
                            } catch (error) {
                                signal?.throwIfAborted();
                                if (
                                    (error.status !== 429 && attempt >= 5) ||
                                    (error.status >= 400 &&
                                        error.status < 500 &&
                                        error.status !== 429)
                                )
                                    throw error;
                                const delay = Math.max(
                                    500 *
                                        2 **
                                            Math.min(
                                                error.status === 429
                                                    ? rateRetries++
                                                    : attempt++,
                                                10,
                                            ),
                                    (Number(error.retryAfter) || 0) * 1000,
                                    (Number(error.body?.seconds) || 0) * 1000,
                                );
                                if (error.status === 429) {
                                    rateWait += delay;
                                    if (rateWait > 300000) throw error;
                                }
                                options.onRetry?.(error);
                                if (stats)
                                    stats.retries = (stats.retries ?? 0) + 1;
                                await new Promise((resolve, reject) => {
                                    const done = () => {
                                        signal?.removeEventListener(
                                            "abort",
                                            abort,
                                        );
                                        resolve();
                                    };
                                    const timer = setTimeout(done, delay);
                                    const abort = () => {
                                        clearTimeout(timer);
                                        signal.removeEventListener(
                                            "abort",
                                            abort,
                                        );
                                        reject(signal.reason);
                                    };
                                    signal?.addEventListener("abort", abort, {
                                        once: true,
                                    });
                                    if (signal?.aborted) abort();
                                });
                            }
                        }
                        signal?.throwIfAborted();
                        if (failed) return;
                        sent += bytes.length;
                        if (stats) {
                            stats.bytes = (stats.bytes ?? 0) + bytes.length;
                            stats.parts =
                                (stats.parts ?? 0) +
                                Math.ceil(bytes.length / PART);
                        }
                        options.onProgress?.(sent / file.size);
                    }
                };
                const results = await Promise.allSettled(
                    Array.from(
                        { length: Math.min(2, Math.ceil(parts / 8)) },
                        () =>
                            worker().catch((error) => {
                                failed = true;
                                throw error;
                            }),
                    ),
                );
                const failure = results.find(
                    (result) => result.status === "rejected",
                );
                if (failure) throw failure.reason;
                signal?.throwIfAborted();
                return {
                    uploadId,
                    name: file.name,
                    mime: file.type || "application/octet-stream",
                };
            } catch (error) {
                if (!controller.signal.aborted)
                    await proxy
                        .cancelUpload(uploadId, controller.signal)
                        .catch(() => {});
                throw error;
            }
        },
        async sendFile(peer, options) {
            disconnected();
            if (peer !== "me" || !options.file?.uploadId) return unavailable();
            const video = options.attributes?.find(
                (a) => a.className === "DocumentAttributeVideo",
            );
            const result = await proxy.finishUpload(options.file.uploadId, {
                name: options.file.name,
                mime: options.file.mime,
                caption: options.caption,
                video: video
                    ? {
                          duration: video.duration,
                          w: video.w,
                          h: video.h,
                          supportsStreaming: video.supportsStreaming,
                      }
                    : undefined,
                forceDocument: options.forceDocument || undefined,
            });
            return message(result.message);
        },
        async getMessages(peer, { ids } = {}) {
            disconnected();
            if (peer !== "me" || ids == null) return unavailable();
            const all = Array.isArray(ids) ? ids : [ids];
            const result = [];
            for (let i = 0; i < all.length; i += 100)
                result.push(
                    ...(
                        await proxy.getMessages(
                            all.slice(i, i + 100),
                            controller.signal,
                        )
                    ).map(message),
                );
            return result;
        },
        async deleteMessages(peer, ids) {
            disconnected();
            if (peer !== "me") return unavailable();
            const deleted = [];
            for (let i = 0; i < ids.length; i += 100)
                deleted.push(
                    ...(await proxy.deleteMessages(
                        ids.slice(i, i + 100),
                        controller.signal,
                    )),
                );
            return deleted;
        },
        getSender() {
            if (controller.signal.aborted)
                return Promise.reject(controller.signal.reason);
            return { isConnected: () => client.connected };
        },
        async invoke(request) {
            disconnected();
            if (
                !(request instanceof Api.upload.GetFile) ||
                !(request.location instanceof Api.InputDocumentFileLocation)
            )
                return unavailable();
            const id = Number(request.location.id);
            const bytes = request.location.thumbSize
                ? await proxy.thumb(id, controller.signal)
                : await proxy.readFile(
                      id,
                      Number(request.offset),
                      request.limit,
                      controller.signal,
                  );
            return new Api.upload.File({ bytes: Buffer.from(bytes) });
        },
        async downloadMedia(media, options = {}) {
            disconnected();
            const doc = (media.media ?? media).document;
            if (!doc) return unavailable();
            if (options.thumb != null)
                return proxy.thumb(Number(doc.id), controller.signal);
            const size = Number(doc.size);
            const out = new Uint8Array(size);
            for (let offset = 0; offset < size; offset += READ) {
                const bytes = await proxy.readFile(
                    Number(doc.id),
                    offset,
                    Math.min(READ, size - offset),
                    controller.signal,
                );
                if (!bytes.length) throw new Error("File truncated");
                out.set(bytes, offset);
                options.progressCallback?.(
                    Math.min(offset + bytes.length, size),
                );
                if (bytes.length !== Math.min(READ, size - offset))
                    throw new Error("File truncated");
            }
            return out;
        },
        destroy() {
            client.connected = false;
            controller.abort(new Error("Telegram is not connected"));
        },
        iterMessages: async (...args) => {
            disconnected();
            return unavailable(...args);
        },
        getMe: async (...args) => {
            disconnected();
            return unavailable(...args);
        },
        _borrowExportedSender: async (...args) => {
            disconnected();
            return unavailable(...args);
        },
        auth: new Proxy(
            {},
            {
                get:
                    () =>
                    async (...args) => {
                        disconnected();
                        return unavailable(...args);
                    },
            },
        ),
    };
    return client;
}

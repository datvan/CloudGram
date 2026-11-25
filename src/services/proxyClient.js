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
    const client = {
        connected: true,
        session: { dcId: 0 },
        async proxyUpload(file, options = {}) {
            const { signal, stats } = options;
            signal?.throwIfAborted();
            const parts = Math.ceil(file.size / PART);
            const { uploadId } = await proxy.startUpload(file.size, parts);
            let sent = 0;
            let next = 0;
            let failed = false;
            try {
                const worker = async () => {
                    while (next < parts && !failed) {
                        signal?.throwIfAborted();
                        const index = next++;
                        const bytes = new Uint8Array(
                            await file
                                .slice(
                                    index * PART,
                                    Math.min(file.size, (index + 1) * PART),
                                )
                                .arrayBuffer(),
                        );
                        signal?.throwIfAborted();
                        for (let attempt = 0; ; attempt += 1) {
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
                                    attempt >= 5 ||
                                    (error.status >= 400 &&
                                        error.status < 500 &&
                                        error.status !== 429)
                                )
                                    throw error;
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
                                    const timer = setTimeout(
                                        done,
                                        500 * 2 ** attempt,
                                    );
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
                            stats.parts = (stats.parts ?? 0) + 1;
                        }
                        options.onProgress?.(sent / file.size);
                    }
                };
                const results = await Promise.allSettled(
                    Array.from({ length: Math.min(4, parts) }, () =>
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
                await proxy.cancelUpload(uploadId).catch(() => {});
                throw error;
            }
        },
        async sendFile(peer, options) {
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
            if (peer !== "me" || ids == null) return unavailable();
            const all = Array.isArray(ids) ? ids : [ids];
            const result = [];
            for (let i = 0; i < all.length; i += 100)
                result.push(
                    ...(await proxy.getMessages(all.slice(i, i + 100))).map(
                        message,
                    ),
                );
            return result;
        },
        async deleteMessages(peer, ids) {
            if (peer !== "me") return unavailable();
            const deleted = [];
            for (let i = 0; i < ids.length; i += 100)
                deleted.push(
                    ...(await proxy.deleteMessages(ids.slice(i, i + 100))),
                );
            return deleted;
        },
        getSender() {
            return { isConnected: () => true };
        },
        async invoke(request) {
            if (
                !(request instanceof Api.upload.GetFile) ||
                !(request.location instanceof Api.InputDocumentFileLocation)
            )
                return unavailable();
            const id = Number(request.location.id);
            const bytes = request.location.thumbSize
                ? await proxy.thumb(id)
                : await proxy.readFile(
                      id,
                      Number(request.offset),
                      request.limit,
                  );
            return new Api.upload.File({ bytes: Buffer.from(bytes) });
        },
        async downloadMedia(media, options = {}) {
            const doc = (media.media ?? media).document;
            if (!doc) return unavailable();
            if (options.thumb != null) return proxy.thumb(Number(doc.id));
            const size = Number(doc.size);
            const out = new Uint8Array(size);
            for (let offset = 0; offset < size; offset += READ) {
                const bytes = await proxy.readFile(
                    Number(doc.id),
                    offset,
                    Math.min(READ, size - offset),
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
        },
        iterMessages: unavailable,
        getMe: unavailable,
        _borrowExportedSender: unavailable,
        auth: new Proxy({}, { get: () => unavailable }),
    };
    return client;
}

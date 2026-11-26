import { ApiError } from "./api";
import { browserId } from "./keystore";
import { PLAY_DIRECT } from "../config/features";
import { diag } from "./diag";

async function request(method, path, body, binary = false, signal, direct) {
    signal?.throwIfAborted();
    let response;
    try {
        response = await fetch(direct?.url ?? `/api/tgx${path}`, {
            method,
            credentials: direct ? "omit" : "same-origin",
            signal,
            headers: {
                ...(direct
                    ? {
                          [method === "GET" ? "X-Read-Key" : "X-Upload-Key"]:
                              direct.key,
                      }
                    : { "X-CloudGram-Browser": browserId() }),
                ...(body === undefined
                    ? {}
                    : {
                          "Content-Type": binary
                              ? "application/octet-stream"
                              : "application/json",
                      }),
            },
            body:
                body === undefined
                    ? undefined
                    : binary
                    ? body
                    : JSON.stringify(body),
        });
    } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.name === "AbortError") throw error;
        if (direct) throw new ApiError(0, "direct_offline");
        throw new ApiError(0, "offline");
    }
    if (binary && method == "GET" && response.ok)
        return new Uint8Array(await response.arrayBuffer());
    const retryAfter = Number(response.headers?.get("Retry-After")) || 0;
    let data;
    try {
        data = await response.json();
    } catch {
        signal?.throwIfAborted();
        const error = new ApiError(
            response.status,
            response.status === 429
                ? "rate_limited"
                : response.status === 502
                ? "server_down"
                : "bad_response",
        );
        error.retryAfter = retryAfter;
        throw error;
    }
    if (!response.ok) {
        const error = new ApiError(
            response.status,
            data.error ?? "error",
            data,
        );
        error.retryAfter = retryAfter;
        throw error;
    }
    return data;
}

export const startUpload = (size, parts, signal) =>
    request("POST", "/upload/start", { size, parts }, false, signal);
export const putPart = (id, index, bytes, signal, direct) =>
    request(
        "PUT",
        `/upload/${encodeURIComponent(id)}/${index}`,
        bytes,
        true,
        signal,
        direct && {
            url: `${direct.origin}/api/tgxd/${encodeURIComponent(id)}/${index}`,
            key: direct.key,
        },
    );
export const finishUpload = async (id, metadata) => {
    const deadline = Date.now() + 180000;
    for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
        try {
            return await request(
                "POST",
                `/upload/${encodeURIComponent(id)}/finish`,
                metadata,
            );
        } catch (error) {
            if (
                !(error instanceof ApiError) ||
                (error.status !== 0 &&
                    !(error.status === 409 && error.code === "busy") &&
                    (error.status < 500 || error.status >= 600)) ||
                (error.status === 503 && error.code === "telegram_busy")
            )
                throw error;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw error;
            await new Promise((resolve) =>
                setTimeout(resolve, Math.min(delay, remaining)),
            );
            if (Date.now() >= deadline) throw error;
        }
    }
};
export const cancelUpload = (id, signal) =>
    request(
        "POST",
        `/upload/${encodeURIComponent(id)}/cancel`,
        {},
        false,
        signal,
    );
export const getMessages = async (ids, signal) =>
    (await request("POST", "/messages", { ids }, false, signal)).messages;
let readKey,
    keyExpires = 0,
    keyRequest,
    directRetryAt = 0,
    readGeneration = 0;

export function resetReadKey() {
    readGeneration++;
    readKey = null;
    keyExpires = 0;
    keyRequest = null;
    directRetryAt = 0;
}

function checkReadGeneration(generation) {
    if (generation !== readGeneration) {
        const error = new Error("Session changed");
        error.name = "AbortError";
        throw error;
    }
}

function getReadKey() {
    if (readKey && Date.now() < keyExpires) return Promise.resolve(readKey);
    if (!keyRequest) {
        const generation = readGeneration;
        const pending = request("POST", "/read-key", {})
            .then((data) => {
                checkReadGeneration(generation);
                if (!data.readKey || !(data.expiresIn > 0))
                    throw new Error("bad key response");
                readKey = data.readKey;
                keyExpires =
                    Date.now() + Math.max(0, data.expiresIn * 1000 - 30000);
                return readKey;
            })
            .finally(() => {
                if (keyRequest === pending) keyRequest = null;
            });
        keyRequest = pending;
    }
    return keyRequest;
}

async function waitForKey(signal) {
    signal?.throwIfAborted();
    let abort;
    try {
        return signal
            ? await Promise.race([
                  getReadKey(),
                  new Promise((_, reject) => {
                      abort = () => reject(signal.reason);
                      signal.addEventListener("abort", abort, { once: true });
                  }),
              ])
            : await getReadKey();
    } finally {
        if (abort) signal.removeEventListener("abort", abort);
    }
}

async function directRead(path, signal) {
    const generation = readGeneration;
    const key = await waitForKey(signal);
    checkReadGeneration(generation);
    signal?.throwIfAborted();
    try {
        return await request("GET", path, undefined, true, signal, {
            url: `${PLAY_DIRECT}/api/tgxd${path}`,
            key,
        });
    } catch (error) {
        checkReadGeneration(generation);
        if (error.status !== 404 || error.code !== "not_found") throw error;
        if (readKey === key) {
            readKey = null;
            keyExpires = 0;
        }
        const fresh = await waitForKey(signal);
        checkReadGeneration(generation);
        signal?.throwIfAborted();
        return await request("GET", path, undefined, true, signal, {
            url: `${PLAY_DIRECT}/api/tgxd${path}`,
            key: fresh,
        });
    }
}

async function read(path, signal) {
    const generation = readGeneration;
    let waited = 0;
    for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
        try {
            if (PLAY_DIRECT && Date.now() >= directRetryAt) {
                try {
                    return await directRead(path, signal);
                } catch (error) {
                    checkReadGeneration(generation);
                    signal?.throwIfAborted();
                    if (error?.name === "AbortError" || error?.status === 429)
                        throw error;
                    if (Date.now() >= directRetryAt) {
                        directRetryAt = Date.now() + 300000;
                        readKey = null;
                        keyExpires = 0;
                        diag("read.direct.fallback");
                    }
                }
            }
            return await request("GET", path, undefined, true, signal);
        } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 429)
                throw error;
            const remaining = 60000 - waited;
            if (remaining <= 0) throw error;
            const pause = Math.max(
                delay,
                (Number(error.retryAfter) || 0) * 1000,
            );
            const duration = Math.min(pause, remaining);
            await new Promise((resolve, reject) => {
                signal?.throwIfAborted();
                const abort = () => {
                    clearTimeout(timer);
                    reject(signal.reason);
                };
                const timer = setTimeout(() => {
                    signal?.removeEventListener("abort", abort);
                    resolve();
                }, duration);
                signal?.addEventListener("abort", abort, { once: true });
            });
            waited += duration;
            if (pause > remaining || waited >= 60000) throw error;
        }
    }
}
export const readFile = (id, offset, limit, signal) =>
    read(`/file/${id}?offset=${offset}&limit=${limit}`, signal);
export const thumb = (id, signal) => read(`/thumb/${id}`, signal);
export const deleteMessages = async (ids, signal) =>
    (await request("POST", "/delete", { ids }, false, signal)).deleted;

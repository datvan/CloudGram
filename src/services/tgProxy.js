import { ApiError } from "./api";
import { browserId } from "./keystore";

async function request(method, path, body, binary = false, signal) {
    signal?.throwIfAborted();
    let response;
    try {
        response = await fetch(`/api/tgx${path}`, {
            method,
            credentials: "same-origin",
            signal,
            headers: {
                "X-CloudGram-Browser": browserId(),
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
        throw new ApiError(0, "offline");
    }
    if (binary && method == "GET" && response.ok)
        return new Uint8Array(await response.arrayBuffer());
    let data;
    try {
        data = await response.json();
    } catch {
        signal?.throwIfAborted();
        throw new ApiError(
            response.status,
            response.status === 502 ? "server_down" : "bad_response",
        );
    }
    if (!response.ok)
        throw new ApiError(response.status, data.error ?? "error", data);
    return data;
}

export const startUpload = (size, parts, signal) =>
    request("POST", "/upload/start", { size, parts }, false, signal);
export const putPart = (id, index, bytes, signal) =>
    request(
        "PUT",
        `/upload/${encodeURIComponent(id)}/${index}`,
        bytes,
        true,
        signal,
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
export const readFile = (id, offset, limit, signal) =>
    request(
        "GET",
        `/file/${id}?offset=${offset}&limit=${limit}`,
        undefined,
        true,
        signal,
    );
export const thumb = (id, signal) =>
    request("GET", `/thumb/${id}`, undefined, true, signal);
export const deleteMessages = async (ids, signal) =>
    (await request("POST", "/delete", { ids }, false, signal)).deleted;

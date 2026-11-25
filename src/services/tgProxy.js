import { ApiError } from "./api";

async function request(method, path, body, binary = false, signal) {
    let response;
    try {
        response = await fetch(`/api/tgx${path}`, {
            method,
            credentials: "same-origin",
            signal,
            headers:
                body === undefined
                    ? {}
                    : {
                          "Content-Type": binary
                              ? "application/octet-stream"
                              : "application/json",
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
        throw new ApiError(
            response.status,
            response.status === 502 ? "server_down" : "bad_response",
        );
    }
    if (!response.ok)
        throw new ApiError(response.status, data.error ?? "error", data);
    return data;
}

export const startUpload = (size, parts) =>
    request("POST", "/upload/start", { size, parts });
export const putPart = (id, index, bytes, signal) =>
    request(
        "PUT",
        `/upload/${encodeURIComponent(id)}/${index}`,
        bytes,
        true,
        signal,
    );
export const finishUpload = (id, metadata) =>
    request("POST", `/upload/${encodeURIComponent(id)}/finish`, metadata);
export const cancelUpload = (id) =>
    request("POST", `/upload/${encodeURIComponent(id)}/cancel`, {});
export const getMessages = async (ids) =>
    (await request("POST", "/messages", { ids })).messages;
export const readFile = (id, offset, limit) =>
    request(
        "GET",
        `/file/${id}?offset=${offset}&limit=${limit}`,
        undefined,
        true,
    );
export const thumb = (id) => request("GET", `/thumb/${id}`, undefined, true);
export const deleteMessages = async (ids) =>
    (await request("POST", "/delete", { ids })).deleted;

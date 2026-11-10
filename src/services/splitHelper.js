// Client of the local helper (public/helper/cloudgram-helper.mjs): it cuts a
// video with the ffmpeg on this computer and hands the pieces back.
import { pieceBytes } from "../utils/splitPlan";

export const HELPER_URL = "http://127.0.0.1:47633";
const HEADERS = { "X-CloudGram": "1" };

export const call = (path, init = {}, signal) =>
    fetch(`${HELPER_URL}${path}`, {
        ...init,
        headers: { ...HEADERS, ...init.headers },
        signal,
    });

/**
 * What the helper says about itself: { ffmpeg, ffprobe, platform }, or null
 * when it is not running (or this page is not allowed to reach it).
 */
export async function helperStatus() {
    try {
        const res = await call("/status", {}, AbortSignal.timeout(2000));
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cut `file` into pieces under `limit` and bring them back as Files named
 * "name.part001.mp4". `onStage` hears "sending", "cutting" and "fetching".
 * The helper's copy is deleted at the end, also when something fails.
 */
export async function splitWithHelper(file, limit, onStage = () => {}) {
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
    onStage("sending");
    const query = new URLSearchParams({
        piece: pieceBytes(limit),
        limit,
        ext,
    });
    const start = await call(`/jobs?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
    });
    if (!start.ok) {
        const { error } = await start.json().catch(() => ({}));
        throw new Error(
            error === "busy"
                ? "Chương trình hỗ trợ đang cắt tệp khác, đợi xong rồi thử lại"
                : `Chương trình hỗ trợ từ chối (${error ?? start.status})`,
        );
    }
    const { id } = await start.json();
    try {
        onStage("cutting");
        let job;
        do {
            await pause(1000);
            job = await (await call(`/jobs/${id}`)).json();
        } while (job.state === "splitting");
        if (job.state !== "done")
            throw new Error(job.error || "Không cắt được video");

        const base = file.name.replace(/\.[^.]+$/, "");
        const parts = [];
        for (let n = 0; n < job.parts.length; n++) {
            onStage("fetching", n + 1, job.parts.length);
            const res = await call(`/jobs/${id}/parts/${n}`);
            if (!res.ok) throw new Error("Không lấy lại được phần đã cắt");
            const name = `${base}.part${String(n + 1).padStart(3, "0")}.mp4`;
            parts.push(
                new File([await res.blob()], name, {
                    type: "video/mp4",
                    lastModified: file.lastModified,
                }),
            );
        }
        return parts;
    } finally {
        await call(`/jobs/${id}`, { method: "DELETE" }).catch(() => {});
    }
}

import { useEffect, useState } from "react";

import { getClient, hasClient } from "../services/telegram";

// Telegram's own limit for a document thumbnail: JPEG, at most 320px a side
const SIZE = 320;
// images uploaded before thumbnails existed have none on Telegram, so they
// are downloaded whole and shrunk here; past this size that costs too much
const FALLBACK_LIMIT = 10 * 1024 * 1024;
const CONCURRENCY = 3;

function isImageType(type) {
    return type?.startsWith("image/") && type !== "image/svg+xml";
}

/** Draw an image or video frame at most SIZE px a side, as a JPEG blob. */
function encodeScaled(source, width, height) {
    const scale = Math.min(1, SIZE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas
        .getContext("2d")
        .drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
        canvas.toBlob(
            (out) => (out ? resolve(out) : reject(new Error("encode failed"))),
            "image/jpeg",
            0.82,
        ),
    );
}

async function shrink(blob) {
    const bitmap = await createImageBitmap(blob);
    try {
        return await encodeScaled(bitmap, bitmap.width, bitmap.height);
    } finally {
        bitmap.close();
    }
}

const asThumbFile = (blob) =>
    new File([blob], "thumb.jpg", { type: "image/jpeg" });

/**
 * Whether Telegram will take this picture as a photo: JPEG or PNG (the only
 * names GramJS sends as a photo), at most 10 MB, width + height at most 10000
 * and a side ratio of at most 20. Anything else goes up as a file.
 */
export async function fitsAsPhoto(file) {
    if (!["image/jpeg", "image/png"].includes(file.type)) return false;
    if (file.size > 10 * 1024 * 1024) return false;
    try {
        const bitmap = await createImageBitmap(file);
        const { width, height } = bitmap;
        bitmap.close();
        return (
            width + height <= 10000 &&
            Math.max(width, height) / Math.min(width, height) <= 20
        );
    } catch {
        return false;
    }
}

/**
 * Duration, size and a cover frame of a video the browser can play, which is
 * what Telegram needs to show it as a playable video. Null when the browser
 * cannot read it; the upload then goes up as a file.
 */
export function probeVideo(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement("video");
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), 15_000);
        video.muted = true;
        video.preload = "auto";
        video.onerror = () => finish(null);
        video.onloadedmetadata = () => {
            if (!video.videoWidth || !Number.isFinite(video.duration)) {
                finish(null);
                return;
            }
            // a second in, past the black first frame most clips start with
            video.currentTime = Math.min(1, video.duration / 2);
        };
        video.onseeked = async () => {
            const info = {
                duration: Math.round(video.duration),
                w: video.videoWidth,
                h: video.videoHeight,
                thumb: undefined,
            };
            try {
                info.thumb = asThumbFile(
                    await encodeScaled(video, info.w, info.h),
                );
            } catch {
                // a video without a cover still plays
            }
            finish(info);
        };
        video.src = url;
    });
}

/**
 * A thumbnail to send along with an upload, so the grid can show it without
 * downloading the original. Undefined for anything that is not a picture the
 * browser can decode; the upload goes ahead without one.
 */
export async function makeThumb(file) {
    if (!isImageType(file.type) || file.size > 50 * 1024 * 1024) {
        return undefined;
    }
    try {
        return asThumbFile(await shrink(file));
    } catch {
        return undefined;
    }
}

// ----- loading -------------------------------------------------------------------

// record id -> object URL, or null when the file has no thumbnail to show.
// Kept for the life of the tab; a few hundred 320px JPEGs is a few MB.
const cache = new Map();
const inflight = new Map();
const queue = [];
let running = 0;

function pickSize(thumbs) {
    // stripped and path sizes are tiny placeholders, not something to show
    const usable = (thumbs ?? []).filter(
        (t) =>
            t.className !== "PhotoStrippedSize" &&
            t.className !== "PhotoPathSize",
    );
    return usable.find((t) => t.type === "m") ?? usable[usable.length - 1];
}

// a retried upload gets a new message, so the key follows file_id too
const keyOf = (record) => `${record.id}:${record.file_id}`;

async function fetchThumb(record) {
    const [message] = await getClient().getMessages("me", {
        ids: record.file_id,
    });
    const media = message?.media;
    // a file sent as a photo carries its own scaled copies instead of thumbs
    const doc = media?.document;
    const sizes = doc ? doc.thumbs : media?.photo?.sizes;
    if (!doc && !sizes) return null;

    const size = pickSize(sizes);
    if (size) {
        const bytes = await getClient().downloadMedia(media, { thumb: size });
        if (bytes?.length) {
            return new Blob([bytes], { type: "image/jpeg" });
        }
    }

    if (
        doc &&
        isImageType(doc.mimeType) &&
        Number(doc.size?.value ?? doc.size) <= FALLBACK_LIMIT
    ) {
        const bytes = await getClient().downloadMedia(media, {});
        return shrink(new Blob([bytes], { type: doc.mimeType }));
    }
    return null;
}

function pump() {
    while (running < CONCURRENCY && queue.length) {
        const { record, resolve } = queue.shift();
        running += 1;
        fetchThumb(record)
            .catch(() => null)
            .then((blob) => {
                const url = blob ? URL.createObjectURL(blob) : null;
                cache.set(keyOf(record), url);
                inflight.delete(keyOf(record));
                resolve(url);
            })
            .finally(() => {
                running -= 1;
                pump();
            });
    }
}

function loadThumb(record) {
    const key = keyOf(record);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (!inflight.has(key)) {
        inflight.set(
            key,
            new Promise((resolve) => {
                queue.push({ record, resolve });
                pump();
            }),
        );
    }
    return inflight.get(key);
}

/**
 * Object URL of a file's thumbnail once `visible` turns true, else null.
 * Only files whose kind can carry a picture are asked for, and only once the
 * upload has finished.
 */
export function useThumbnail(record, wanted, visible) {
    const ready = wanted && record.file_id != null;
    const [url, setUrl] = useState(() =>
        ready ? cache.get(keyOf(record)) ?? null : null,
    );

    useEffect(() => {
        if (!ready || !visible || !hasClient()) return undefined;
        let cancelled = false;
        loadThumb(record).then((next) => !cancelled && setUrl(next));
        return () => {
            cancelled = true;
        };
        // a new file_id means a fresh upload; the record object itself changes
        // on every rename or star and must not refetch
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [record.id, record.file_id, ready, visible]);

    return ready ? url : null;
}

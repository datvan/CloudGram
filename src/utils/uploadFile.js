import { Api, errors } from "telegram";

import { getClient } from "../services/telegram";
import { Store } from "../redux/store";
import { uploadProgress } from "../redux/actions/progressAction";
import { FILE_ENCRYPTION, SPLIT_RAW } from "../config/features";
import {
    CHUNK,
    ENC_CHUNK,
    chunkCount,
    encryptChunk,
    encryptedSize,
    importFileKey,
    newFileKey,
} from "../services/fileCrypto";
import { pieceName, splitSizes } from "./splitPlan";
import {
    encryptedThumb,
    fitsAsPhoto,
    makeThumb,
    probeVideo,
    typeOf,
} from "./thumbnails";
import { turns, uploadParts } from "./transfer";
import { sliceLimit } from "./uploadLimit";

// Messages being sent at once. The pool frees a file's place once its parts
// are out, so without a cap a large folder had hundreds of sends waiting on
// Telegram together: it made them all wait (FLOOD_WAIT), they all asked again
// at the same moment, and files sat at 100% without their tick for good.
const sendTurns = turns(4);
// ms after which a send still waiting lets the next one go anyway
const SEND_STUCK = 120000;

// what Telegram itself plays inline; other containers go up as files
const STREAMABLE = ["video/mp4", "video/quicktime", "video/x-m4v"];

/**
 * How to send a file: as a photo or a playable video like the Telegram apps
 * do by default (`asMedia`), or as a file kept byte for byte. A file that
 * Telegram would not take as media falls back to a file.
 */
async function sendOptions(file, asMedia) {
    if (asMedia && (await fitsAsPhoto(file))) {
        return { kind: "photo", options: { forceDocument: false } };
    }
    const type = typeOf(file);
    const video = type.startsWith("video/") ? await probeVideo(file) : null;
    if (asMedia && STREAMABLE.includes(type)) {
        if (video?.duration !== undefined) {
            return {
                kind: "video",
                options: {
                    forceDocument: false,
                    supportsStreaming: true,
                    thumb: video.thumb,
                    attributes: [
                        new Api.DocumentAttributeVideo({
                            duration: video.duration,
                            w: video.w,
                            h: video.h,
                            supportsStreaming: true,
                        }),
                    ],
                },
            };
        }
    }
    return {
        kind: "file",
        options: {
            forceDocument: true,
            // lets the grid show pictures and videos without downloading
            // the originals
            thumb: video ? video.thumb : await makeThumb(file),
        },
    };
}

function largestPhotoSize(photo) {
    return Math.max(
        0,
        ...(photo?.sizes ?? []).map((s) =>
            "sizes" in s ? Math.max(...s.sizes) : s.size ?? 0,
        ),
    );
}

/**
 * Send one file to Saved Messages. Resolves to the message plus the record
 * fields the way it was sent changes: a photo is recompressed to JPEG by
 * Telegram, so its stored name, type and size follow what is actually there.
 *
 * Completion is left to the caller: the file still has to be written back to
 * its record, and clearing the progress entry here would make the upload look
 * finished while the record had no file_id yet.
 *
 * The bytes go up through transfer.js, which reads the file part by part,
 * and GramJS only gets the finished InputFile to send. `resume` is handed on
 * to uploadParts, so a second attempt skips the parts already sent.
 *
 * A send that fails without an answer from Telegram may still have gone
 * through, so the error is marked `maybeSent` and the caller should not send
 * again on its own.
 */
/**
 * The record fields a sent message changes. Also used for a message found
 * again after a reload, when the upload that sent it is gone.
 */
export function sentChanges(message, kind, size) {
    const changes = { sentAs: kind };
    if (kind === "photo" && message.media?.photo) {
        changes.mime = "image/jpeg";
        changes.size = largestPhotoSize(message.media.photo) || size;
    }
    return changes;
}

// GramJS refuses a request outright once the client is disconnected (the
// lease went elsewhere), before anything is queued, so nothing went out
const neverQueued = (error) =>
    /^Cannot send requests while disconnected/.test(error?.message ?? "");

// the page hears about a file's progress at most this often; every 512 KB
// part would be a dozen updates a second per file
const PROGRESS_EVERY = 250;

// how far back the upload speed looks, so it neither jumps with every part
// nor lags a change in the connection by long
const SPEED_WINDOW = 3000;

// Present encrypted bytes as a seekable source for Telegram's upload parts.
export async function encryptedSource(file, enc, name) {
    const key = await importFileKey(enc);
    const size = encryptedSize(file.size);
    return {
        name,
        size,
        slice(start, end) {
            return {
                async arrayBuffer() {
                    const first = Math.floor(start / ENC_CHUNK);
                    const last = Math.floor((end - 1) / ENC_CHUNK);
                    const out = new Uint8Array(end - start);
                    let written = 0;
                    for (let i = first; i <= last; i += 1) {
                        const plain = await file
                            .slice(
                                i * CHUNK,
                                Math.min(file.size, (i + 1) * CHUNK),
                            )
                            .arrayBuffer();
                        const bytes = await encryptChunk(
                            key,
                            enc,
                            i,
                            plain,
                            i === chunkCount(file.size) - 1,
                        );
                        const from = Math.max(0, start - i * ENC_CHUNK);
                        const to = Math.min(bytes.length, end - i * ENC_CHUNK);
                        out.set(bytes.subarray(from, to), written);
                        written += to - from;
                    }
                    return out.buffer;
                },
            };
        },
    };
}

const randomName = () =>
    `cg-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("")}.bin`;

async function fingerprint(file) {
    const samples = [
        file.slice(0, 1024 * 1024),
        file.slice(Math.max(0, file.size - 1024 * 1024)),
    ];
    for (let i = 1; i < 8; i += 1) {
        const start = Math.floor((file.size * i) / 8);
        samples.push(file.slice(start, start + CHUNK));
    }
    const buffers = await Promise.all(
        samples.map((sample) => sample.arrayBuffer()),
    );
    const bytes = new Uint8Array(
        8 + buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0),
    );
    new DataView(bytes.buffer).setBigUint64(0, BigInt(file.size));
    let offset = 8;
    for (const buffer of buffers) {
        bytes.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("");
}

/** Feed it the bytes sent so far; it answers with bytes a second lately. */
function speedMeter() {
    const samples = [];
    return (sent) => {
        const now = performance.now();
        samples.push([now, sent]);
        while (samples.length > 2 && samples[1][0] <= now - SPEED_WINDOW)
            samples.shift();
        const [since, from] = samples[0];
        // a part or two is not enough to say anything
        if (now - since < 500) return undefined;
        return ((sent - from) * 1000) / (now - since);
    };
}

export default async function uploadFile(
    id,
    file,
    {
        asMedia = false,
        resume = {},
        onSend,
        onPiece,
        client: boundClient,
        assertCurrent,
        onRetry,
        onEncryption,
        onProgress,
    } = {},
) {
    // bigger than one message takes: raw slices, one message each
    const limit = sliceLimit();
    const encrypted = resume?.encrypted ?? FILE_ENCRYPTION;
    const client = boundClient ?? getClient();
    const print = encrypted ? await fingerprint(file) : undefined;
    assertCurrent?.();
    const keys = [
        resume.enc,
        ...(resume.pieces ?? []).map((p) => p.enc),
    ].filter(Boolean);
    if (encrypted && keys.some((enc) => enc.fingerprint !== print)) {
        const ids = (resume.pieces ?? []).map((p) => p.id);
        if (ids.length)
            client
                .deleteMessages("me", ids, { revoke: true })
                .catch((error) =>
                    console.log("Could not delete slices", error),
                );
        resume.pieces = undefined;
        resume.enc = undefined;
        resume.name = undefined;
        resume.fileId = undefined;
        resume.done = undefined;
    }
    if (encrypted && resume.thumbData === undefined) {
        resume.thumbData = (await encryptedThumb(file)) ?? null;
    }
    const plainLimit =
        encrypted && Number.isFinite(limit)
            ? Math.floor(limit / ENC_CHUNK) * CHUNK
            : limit;
    const slices = SPLIT_RAW ? splitSizes(file.size, plainLimit) : [file.size];
    // slices sent by an earlier attempt that saw a smaller limit still count
    const cut = slices.length > 1 || resume?.pieces?.length > 0;
    if (encrypted && cut && !resume.pieces && resume.enc?.size === file.size) {
        // A smaller limit requires a fresh key and new Telegram upload parts.
        resume.enc = undefined;
        resume.name = undefined;
        resume.fileId = undefined;
        resume.done = undefined;
    }
    const { kind, options } = encrypted
        ? { kind: "file", options: { forceDocument: true } }
        : await sendOptions(
              file,
              // the slices are plain files, nothing Telegram would play or recompress
              cut ? false : asMedia,
          );
    assertCurrent?.();

    const speed = speedMeter();
    let told = 0;
    // `sentBytes` of the whole file are out by now
    const report = (sentBytes) => {
        assertCurrent?.();
        const fraction = sentBytes / Math.max(1, file.size);
        onProgress?.(fraction * 100);
        const rate = speed(sentBytes);
        const now = performance.now();
        if (fraction < 1 && now - told < PROGRESS_EVERY) return;
        told = now;
        // every part is out: what is left is sending the message, which
        // moves no bytes however long it waits
        Store.dispatch(
            uploadProgress(id, fraction * 100, fraction < 1 ? rate : 0),
        );
    };

    /** Send one message for bytes already uploaded; `final` is the last one. */
    async function send(inputFile, extra, final) {
        await sendTurns.take();
        let given = false;
        const give = () => {
            if (given) return;
            given = true;
            sendTurns.give();
        };
        // a send that never answers must not hold up every file behind it
        const stuck = setTimeout(give, SEND_STUCK);
        let sending = false;
        try {
            // from here a closed tab may leave a message nobody recorded
            await onSend?.(kind, final);
            assertCurrent?.();
            sending = true;
            return await client.sendFile("me", {
                file: inputFile,
                ...extra,
            });
        } catch (error) {
            if (
                sending &&
                !(error instanceof errors.RPCError) &&
                !neverQueued(error)
            )
                error.maybeSent = true;
            throw error;
        } finally {
            clearTimeout(stuck);
            give();
        }
    }

    if (!cut) {
        let source = file;
        if (encrypted) {
            resume.enc ??= {
                ...newFileKey(),
                size: file.size,
                fingerprint: print,
            };
            resume.name ??= randomName();
            await onEncryption?.();
            assertCurrent?.();
            source = await encryptedSource(file, resume.enc, resume.name);
        }
        const inputFile = await uploadParts(client, source, {
            resume,
            onRetry,
            onProgress: (fraction) => report(fraction * file.size),
        });
        const message = await send(inputFile, options, true);
        return {
            message,
            changes: {
                ...sentChanges(message, kind, file.size),
                ...(encrypted
                    ? { enc: resume.enc, thumbData: resume.thumbData }
                    : {}),
            },
        };
    }

    // `resume.pieces` keeps the messages already sent, through retries, so
    // no attempt sends a slice twice; `resume.fileId`/`done` are the slice in
    // flight, cleared once its message is out.
    // The ids are logged (onPiece), so a reopened tab goes on from the next
    // slice. shortcut: the window between a send answering and its log write
    // can leave one slice nobody knows of; "Nhập từ Telegram" finds it.
    const sent = (resume.pieces ??= []);
    if (resume.verify) {
        resume.verify = undefined;
        // slices a reopened tab was told about may have been deleted since
        const found = new Map();
        if (sent.length)
            for (const m of await client.getMessages("me", {
                ids: sent.map((piece) => piece.id),
            }))
                if (m) found.set(m.id, m);
        const size = (m) => {
            const doc = m?.media?.document;
            return Number(doc?.size?.value ?? doc?.size);
        };
        const bad = sent.findIndex(
            (p) =>
                size(found.get(p.id)) !==
                (p.enc ? encryptedSize(p.size) : p.size),
        );
        // shortcut: slices after the first missing one stay in Saved Messages
        if (bad >= 0) {
            sent.length = bad;
            resume.enc = undefined;
            resume.name = undefined;
            resume.fileId = undefined;
            resume.done = undefined;
        }
    }
    let offset = sent.reduce((sum, piece) => sum + piece.size, 0);
    // cut again from what is left, so a limit that changed since the last
    // attempt (the profile loaded) cannot make the slices miss the end
    while (offset < file.size) {
        const i = sent.length;
        const [planned] = splitSizes(file.size - offset, plainLimit);
        const next = resume.enc?.size ?? planned;
        const last = next === file.size - offset;
        // another account since the slice before: nothing more goes out
        assertCurrent?.();
        const piece = new File(
            [file.slice(offset, offset + next)],
            pieceName(file.name, i),
        );
        const base = offset;
        let source = piece;
        if (encrypted) {
            resume.enc ??= {
                ...newFileKey(),
                size: piece.size,
                fingerprint: print,
            };
            resume.name ??= randomName();
            await onEncryption?.();
            assertCurrent?.();
            source = await encryptedSource(piece, resume.enc, resume.name);
        }
        const inputFile = await uploadParts(client, source, {
            resume,
            onRetry,
            onProgress: (fraction) => report(base + fraction * piece.size),
        });
        // the first slice carries the picture the grid shows
        const message = await send(
            inputFile,
            i === 0 ? options : { forceDocument: true },
            last,
        );
        sent.push({
            id: message.id,
            size: piece.size,
            ...(encrypted ? { enc: resume.enc } : {}),
        });
        resume.fileId = undefined;
        resume.done = undefined;
        resume.enc = undefined;
        resume.name = undefined;
        await onPiece?.();
        offset += piece.size;
    }
    const [first] = sent;
    return {
        message: { id: first.id },
        // every message to delete if the record is gone by now
        messages: sent.map((piece) => piece.id),
        changes: {
            sentAs: "file",
            ...(encrypted ? { thumbData: resume.thumbData } : {}),
            parts: sent.map(({ id, size, enc }) => ({
                id,
                size,
                ...(enc ? { enc } : {}),
            })),
        },
    };
}

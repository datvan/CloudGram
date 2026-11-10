/**
 * Open a video in PotPlayer, VLC or mpv on this computer.
 *
 * A player cannot read from this tab, which holds the Telegram session. So
 * the server keeps a cache in between (server/play.js): the player reads a
 * Range address there, the server asks this tab, by a long poll, for the 2 MiB
 * chunks the player needs and some ahead of it, and each is read from Telegram
 * here (stream.js) and put to the server. The tab has to stay open while the
 * video plays; the server drops the cache when it does not.
 */
import { api, putPlayChunk } from "./api";
import { PLAY_DIRECT } from "../config/features";
import { readRange, streamQueue } from "./stream";
import { flight, trouble } from "../utils/transfer";
import { isOnline } from "./telegram";

// polls open at once: a player asks for several ranges together
const WORKERS = 3;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message, code) => Object.assign(new Error(message), { code });

/** file_id -> { url, stop }: a video already open is not opened twice */
const open = new Map();

/** readRange, waiting out a Telegram reconnect (up to ~30 s) instead of failing */
async function readWhenOnline(record, start, end) {
    for (let tries = 0; ; tries += 1) {
        try {
            return await readRange(record, start, end);
        } catch (error) {
            if (error.message !== "offline" || tries >= 15) throw error;
            await pause(2000);
        }
    }
}

/** Answer the server's chunk requests until the video is closed. */
async function serve(made, record, size, state) {
    let failures = 0;
    state.alive += 1;
    try {
        await loop();
    } finally {
        state.alive -= 1;
        console.log("relay worker ended:", state.why);
    }

    async function loop() {
        while (!state.stopped) {
            let next;
            try {
                next = await api.playNext(made.id, state.direct);
            } catch (error) {
                // closed on the server (or signed out): the video is over
                if (error.status === 401 || error.status === 404) {
                    state.why = `session gone (${error.status})`;
                    return;
                }
                // shortcut: retries for as long as the video is open, 10 s apart
                // at most; the server drops the session when nobody answers
                failures += 1;
                state.error = `hỏi máy chủ lỗi ${error.status ?? ""} ${
                    error.code ?? ""
                }`;
                console.log("relay poll failed", failures, error);
                await pause(Math.min(1000 * failures, 10_000));
                continue;
            }
            failures = 0;
            if (next.index === null) continue;
            if (!(await chunk(next.index))) return;
        }
        state.why = "stopped";
    }

    /** Read one chunk from Telegram and put it to the server; false: give up. */
    async function chunk(index) {
        const start = index * made.chunk;
        const began = Date.now();
        state.reading.set(index, began);
        try {
            const { bytes } = await readWhenOnline(
                record,
                start,
                Math.min(size - 1, start + made.chunk - 1),
            );
            const read = Date.now() - began;
            await putPlayChunk(made.id, index, bytes, state.direct);
            state.sent += 1;
            console.log(
                `relay chunk ${index}: read ${read} ms, sent ${
                    Date.now() - began - read
                } ms`,
            );
            return true;
        } catch (error) {
            console.log(error);
            state.error = String(error.errorMessage ?? error.message);
            if (error.status === 404 || error.status === 401) {
                state.why = `put refused (${error.status})`;
                return false;
            }
            // tell the server, so the player's stream is cut and not left hanging
            await api.failPlay(made.id, index).catch(() => {});
            return true;
        } finally {
            state.reading.delete(index);
        }
    }
}

/**
 * Make `record` playable at an address on the server. Resolves with
 * `{ url, stop }`; throws with `.code` "read" (Telegram), "off", "busy",
 * "disk" or "server", and a message to show.
 */
export async function startRelay(record) {
    const known = open.get(record.file_id);
    if (known) return known;
    let first;
    try {
        first = await readRange(record, 0, 0);
    } catch (error) {
        console.log(error);
        throw fail("Không đọc được tệp từ Telegram.", "read");
    }
    let made;
    try {
        made = await api.createPlay({
            name: record.name,
            size: first.size,
            type: first.type,
        });
    } catch (error) {
        throw error.code === "play_off"
            ? fail("Máy chủ đang tắt tính năng này.", "off")
            : error.code === "play_busy"
            ? fail("Máy chủ đang phát nhiều video, thử lại sau.", "busy")
            : error.code === "disk_full"
            ? fail("Máy chủ hết chỗ chứa tạm.", "disk")
            : fail("Không kết nối được máy chủ CloudGram.", "server");
    }
    const state = {
        stopped: false,
        alive: 0,
        why: "",
        reading: new Map(),
        sent: 0,
        error: "",
        // the address that skips Cloudflare, until one try cannot reach it
        direct:
            PLAY_DIRECT && made.key
                ? {
                      url: PLAY_DIRECT,
                      key: made.key,
                      failed: () => (state.direct = null),
                  }
                : null,
    };
    const session = {
        // for the dialog: what the tab is doing for the player right now
        status: () => ({
            sent: state.sent,
            // polls still asking the server for chunks (WORKERS when well)
            alive: state.alive,
            reading: state.reading.size,
            seconds: Math.round(
                (Date.now() - Math.min(Date.now(), ...state.reading.values())) /
                    1000,
            ),
            error: state.error,
            online: isOnline(),
            // what Telegram requests are doing: running, queued, stuck on a
            // connection or on an answer, and the last wait or error
            queue: streamQueue(),
            flight: { ...flight },
            trouble: Date.now() - trouble.at < 120_000 ? trouble.text : "",
        }),
        url: `${window.location.origin}${made.path}`,
        stop: () => {
            state.stopped = true;
            open.delete(record.file_id);
            return api.closePlay(made.id).catch(() => {});
        },
    };
    open.set(record.file_id, session);
    const done = [];
    for (let i = 0; i < WORKERS; i += 1)
        done.push(serve(made, record, first.size, state));
    // every poll over: closed here, on the server, or signed out
    Promise.all(done).then(() => {
        state.stopped = true;
        if (open.get(record.file_id) === session) open.delete(record.file_id);
    });
    return session;
}

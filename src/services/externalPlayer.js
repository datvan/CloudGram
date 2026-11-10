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
import { readRange } from "./stream";
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
    while (!state.stopped) {
        let next;
        try {
            next = await api.playNext(made.id);
        } catch (error) {
            // closed on the server (or signed out): the video is over
            if (error.status === 401 || error.status === 404) return;
            if ((failures += 1) >= 5) return;
            await pause(1000);
            continue;
        }
        failures = 0;
        if (next.index === null) continue;
        const start = next.index * made.chunk;
        const began = Date.now();
        state.reading.set(next.index, began);
        try {
            const { bytes } = await readWhenOnline(
                record,
                start,
                Math.min(size - 1, start + made.chunk - 1),
            );
            const read = Date.now() - began;
            await putPlayChunk(made.id, next.index, bytes);
            state.sent += 1;
            console.log(
                `relay chunk ${next.index}: read ${read} ms, sent ${
                    Date.now() - began - read
                } ms`,
            );
        } catch (error) {
            console.log(error);
            state.error = String(error.errorMessage ?? error.message);
            if (error.status === 404 || error.status === 401) return;
            // tell the server, so the player's stream is cut and not left hanging
            await api.failPlay(made.id, next.index).catch(() => {});
        } finally {
            state.reading.delete(next.index);
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
    const state = { stopped: false, reading: new Map(), sent: 0, error: "" };
    const session = {
        // for the dialog: what the tab is doing for the player right now
        status: () => ({
            sent: state.sent,
            reading: state.reading.size,
            seconds: Math.round(
                (Date.now() - Math.min(Date.now(), ...state.reading.values())) /
                    1000,
            ),
            error: state.error,
            online: isOnline(),
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

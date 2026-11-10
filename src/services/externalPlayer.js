/**
 * Open a video in PotPlayer, VLC or mpv on this computer.
 *
 * A player cannot read from this page, so the local helper (splitHelper.js,
 * public/helper) gives it an address on 127.0.0.1 and asks this page, which
 * holds the Telegram session, for the bytes the player wants: each one is a
 * poll the helper answers with a range, and the bytes go back in a POST. The
 * page sends only the player's name, never a path. The tab has to stay open
 * while the video plays.
 */
import { call, helperStatus } from "./splitHelper";
import { readRange } from "./stream";

// the order a player is picked in when the user has not chosen
const PREFERRED = ["potplayer", "vlc", "mpv"];
export const PLAYER_LABEL = { potplayer: "PotPlayer", vlc: "VLC", mpv: "mpv" };

// polls open at once: a player asks for several ranges together
const WORKERS = 3;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What can be done now: { helper: false } when the helper is not running,
 * else the players it found (in the order to offer them).
 */
export async function externalPlayers() {
    const status = await helperStatus();
    if (!status) return { helper: false, players: [] };
    const found = status.players ?? [];
    return {
        helper: true,
        // an older helper has no players list at all
        outdated: !("players" in status),
        players: PREFERRED.filter((name) => found.includes(name)),
    };
}

/** Answer the helper's requests until it closes the video or goes away. */
async function serve(token, record, state) {
    let failures = 0;
    while (!state.stopped) {
        let next;
        try {
            next = await call(`/bridge/${token}/next`);
        } catch {
            // the helper went away; a few tries, then the video is over
            if ((failures += 1) >= 3) return;
            await pause(1000);
            continue;
        }
        failures = 0;
        if (next.status === 204) continue;
        if (next.status !== 200) return;
        const { id, start, end } = await next.json();
        let body;
        let query = "";
        try {
            const { bytes } = await readRange(record, start, end);
            body = bytes;
        } catch (error) {
            console.log(error);
            query = "?error=1";
        }
        await call(`/bridge/${token}/${id}${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body,
        }).catch(() => {});
    }
}

/**
 * Start `record` in `player`. Resolves once the helper has launched it;
 * `stop()` closes the video on the helper's side. Throws with `.code`
 * "helper", "player" or "read" (and a message to show).
 */
export async function openInPlayer(record, player) {
    let first;
    try {
        first = await readRange(record, 0, 0);
    } catch (error) {
        console.log(error);
        throw Object.assign(new Error("Không đọc được tệp từ Telegram."), {
            code: "read",
        });
    }
    let res;
    try {
        res = await call("/play", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: record.name,
                size: first.size,
                type: first.type,
                player,
            }),
        });
    } catch {
        throw Object.assign(new Error("Chương trình hỗ trợ không chạy."), {
            code: "helper",
        });
    }
    if (!res.ok)
        throw Object.assign(
            new Error(`Không mở được ${PLAYER_LABEL[player] ?? player}.`),
            { code: "player" },
        );
    const { token } = await res.json();
    const state = { stopped: false };
    for (let i = 0; i < WORKERS; i += 1) serve(token, record, state);
    return {
        stop: () => {
            state.stopped = true;
            return call(`/bridge/${token}`, { method: "DELETE" }).catch(
                () => {},
            );
        },
    };
}

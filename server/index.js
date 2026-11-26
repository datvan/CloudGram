/**
 * Entry point. Configuration comes from the environment, set by the systemd
 * unit from /etc/cloudgram-api.env:
 *
 *     CLOUDGRAM_PEPPER   random secret, 32+ chars; never in this repo
 *     CLOUDGRAM_DATA     data directory (default /var/lib/cloudgram-api)
 *     CLOUDGRAM_ORIGIN   expected Origin header (default https://cloudgram.example.com)
 *     CLOUDGRAM_SHARE_QUOTA_GB  disk each account may use for share links (default 20)
 *     CLOUDGRAM_PLAY     0 turns off opening a video in PotPlayer/VLC (default on)
 *     CLOUDGRAM_PLAY_CACHE_MB  disk for the player cache, all videos (default 1024)
 *     PORT               loopback port (default 4322)
 */
import { CloudGramApi, HttpError } from "./app.js";
import { Db } from "./db.js";
import { SharedTelegram } from "./shared-telegram.js";
import { Owners } from "./owners.js";
import { TelegramProxy } from "./tg-proxy.js";
import { createApiServer } from "./http.js";

const port = Number(process.env.PORT ?? 4322);
const db = await new Db(
    process.env.CLOUDGRAM_DATA ?? "/var/lib/cloudgram-api",
).open();
const sharedTelegram = new SharedTelegram(db.dir);
const owners = await new Owners(db.dir).open();
let client;
let connecting;
let generation = 0;
async function telegramClient() {
    if (client?.connected) return client;
    if (!connecting) {
        const current = generation;
        const pending = (async () => {
            const session = await sharedTelegram.load();
            if (!session) throw new HttpError(503, "telegram_not_linked");
            const next = client ?? (await sharedTelegram.client(session));
            await next.connect();
            if (generation === current) client = next;
            return next;
        })();
        connecting = pending;
        pending.then(
            () => {
                if (connecting === pending) connecting = null;
            },
            () => {
                if (connecting === pending) connecting = null;
            },
        );
    }
    return connecting;
}
const telegram = Object.fromEntries(
    ["invoke", "getMessages", "sendFile", "deleteMessages"].map((method) => [
        method,
        async (...args) => {
            const current = generation;
            const connected = await telegramClient();
            if (current !== generation)
                throw new HttpError(503, "telegram_busy");
            return connected[method](...args);
        },
    ]),
);
const tgx = new TelegramProxy({
    owners,
    telegram,
    onTimeout: () => {
        generation++;
        client = null;
        connecting = null;
    },
});
const api = new CloudGramApi({
    db,
    pepper: process.env.CLOUDGRAM_PEPPER,
    shareQuota: Number(process.env.CLOUDGRAM_SHARE_QUOTA_GB ?? 20) * 1024 ** 3,
    sharedTelegram,
    tgx,
    tgxDirect: process.env.CLOUDGRAM_TGX_DIRECT === "1",
    tgxDirectRead: process.env.CLOUDGRAM_TGX_DIRECT_READ === "1",
    credentialGuard: process.env.CLOUDGRAM_SECURITY_CREDENTIAL_GUARD !== "0",
    shareQuotaGuard: process.env.CLOUDGRAM_SECURITY_SHARE_QUOTA !== "0",
    play: {
        enabled: process.env.CLOUDGRAM_PLAY !== "0",
        limits: {
            totalBytes:
                Number(process.env.CLOUDGRAM_PLAY_CACHE_MB ?? 1024) * 1024 ** 2,
        },
    },
});
// a restart leaves no open video, so whatever it cached is dropped
await api.play.reset();

const server = createApiServer(api, {
    origin: process.env.CLOUDGRAM_ORIGIN ?? "https://cloudgram.example.com",
    secureCookies: process.env.CLOUDGRAM_INSECURE_COOKIES !== "1",
    diagLog: process.env.CLOUDGRAM_DIAG_LOG !== "0",
});

// also deletes expired share links
setInterval(() => api.sweep().catch(console.error), 60_000).unref();

// every deploy and every cloudgram-admin call restarts the service; let the
// last queued write land before exiting
process.on("SIGTERM", () => {
    server.close();
    db.queue.then(() => process.exit(0));
});

// loopback only: nginx is the one public way in
server.listen(port, "127.0.0.1", () => {
    console.log(`cloudgram-api listening on 127.0.0.1:${port}`);
});

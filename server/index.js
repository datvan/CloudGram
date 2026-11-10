/**
 * Entry point. Configuration comes from the environment, set by the systemd
 * unit from /etc/cloudgram-api.env:
 *
 *     CLOUDGRAM_PEPPER   random secret, 32+ chars; never in this repo
 *     CLOUDGRAM_DATA     data directory (default /var/lib/cloudgram-api)
 *     CLOUDGRAM_ORIGIN   expected Origin header (default https://cloudgram.datvan.com)
 *     CLOUDGRAM_SHARE_QUOTA_GB  disk each account may use for share links (default 20)
 *     CLOUDGRAM_PLAY     0 turns off opening a video in PotPlayer/VLC (default on)
 *     CLOUDGRAM_PLAY_CACHE_MB  disk for the player cache, all videos (default 1024)
 *     PORT               loopback port (default 4322)
 */
import { CloudGramApi } from "./app.js";
import { Db } from "./db.js";
import { createApiServer } from "./http.js";

const port = Number(process.env.PORT ?? 4322);
const db = await new Db(
    process.env.CLOUDGRAM_DATA ?? "/var/lib/cloudgram-api",
).open();
const api = new CloudGramApi({
    db,
    pepper: process.env.CLOUDGRAM_PEPPER,
    shareQuota: Number(process.env.CLOUDGRAM_SHARE_QUOTA_GB ?? 20) * 1024 ** 3,
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
    origin: process.env.CLOUDGRAM_ORIGIN ?? "https://cloudgram.datvan.com",
    secureCookies: process.env.CLOUDGRAM_INSECURE_COOKIES !== "1",
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

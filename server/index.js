/**
 * Entry point. Configuration comes from the environment, set by the systemd
 * unit from /etc/cloudgram-api.env:
 *
 *     CLOUDGRAM_PEPPER   random secret, 32+ chars; never in this repo
 *     CLOUDGRAM_DATA     data directory (default /var/lib/cloudgram-api)
 *     CLOUDGRAM_ORIGIN   expected Origin header (default https://cloudgram.datvan.com)
 *     PORT               loopback port (default 4322)
 */
import { CloudGramApi } from "./app.js";
import { Db } from "./db.js";
import { createApiServer } from "./http.js";

const port = Number(process.env.PORT ?? 4322);
const db = await new Db(
    process.env.CLOUDGRAM_DATA ?? "/var/lib/cloudgram-api",
).open();
const api = new CloudGramApi({ db, pepper: process.env.CLOUDGRAM_PEPPER });

const server = createApiServer(api, {
    origin: process.env.CLOUDGRAM_ORIGIN ?? "https://cloudgram.datvan.com",
    secureCookies: process.env.CLOUDGRAM_INSECURE_COOKIES !== "1",
});

setInterval(() => api.sweep(), 60_000).unref();

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

/**
 * Dropbox import, server half: turn a shared link into a download URL.
 *
 * The browser does the importing itself, streaming the files straight from
 * Dropbox into Telegram. It cannot start that alone: www.dropbox.com answers a
 * shared link with a redirect that carries no CORS header, so a page cannot
 * follow it. The URL it redirects to, on *.dl.dropboxusercontent.com, does
 * allow any origin. So this asks Dropbox for the redirect and hands back where
 * it points; the bytes never pass through here.
 *
 * Only Dropbox shared links are fetched, and only redirects that stay on
 * Dropbox are followed, so this cannot be pointed at anything else.
 */
import { HttpError } from "./app.js";
import { Window } from "./shares.js";

const SHARED_PATH = /^\/(scl\/f[oi]|sh|s)\//;
const MAX_HOPS = 3;
const TIMEOUT_MS = 15_000;

/** The link as Dropbox serves it for download, or null if it is not one. */
export function normalizeLink(value) {
    let url;
    try {
        url = new URL(String(value).trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "www.dropbox.com" && url.hostname !== "dropbox.com")
        return null;
    if (!SHARED_PATH.test(url.pathname)) return null;
    url.hostname = "www.dropbox.com";
    url.hash = "";
    url.searchParams.set("dl", "1");
    return url;
}

const isDownloadHost = (host) =>
    host === "dl.dropboxusercontent.com" ||
    host.endsWith(".dl.dropboxusercontent.com");

export class Dropbox {
    constructor({ authenticate, now, fetch = globalThis.fetch }) {
        this.authenticate = authenticate;
        this.now = now;
        this.fetch = fetch;
        this.byUser = new Window(120, 15 * 60 * 1000);
    }

    async resolve(req, res) {
        const { user } = await this.authenticate(req, res);
        this.byUser.take(user.username, this.now());
        let url = normalizeLink(req.body.url);
        if (!url) throw new HttpError(400, "dropbox_bad_link");

        for (let hop = 0; hop < MAX_HOPS; hop += 1) {
            let reply;
            try {
                reply = await this.fetch(url, {
                    redirect: "manual",
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
            } catch {
                throw new HttpError(502, "dropbox_unreachable");
            }
            // only the status and the Location matter
            reply.body?.cancel().catch(() => {});

            if (reply.status === 404 || reply.status === 410)
                throw new HttpError(404, "dropbox_not_found");
            if (reply.status === 429) throw new HttpError(429, "dropbox_busy");
            if (reply.status < 300 || reply.status >= 400)
                // a 200 here is an HTML page: a password prompt, a removed
                // link, or a folder too big to download as one ZIP
                throw new HttpError(422, "dropbox_unavailable");

            let next;
            try {
                next = new URL(reply.headers.get("location"), url);
            } catch {
                throw new HttpError(502, "dropbox_unavailable");
            }
            if (next.protocol === "https:" && isDownloadHost(next.hostname))
                return { url: next.href };
            // Dropbox sometimes rewrites an old link to its new form first
            const again = normalizeLink(next.href);
            if (!again) throw new HttpError(422, "dropbox_unavailable");
            url = again;
        }
        throw new HttpError(422, "dropbox_unavailable");
    }

    sweep() {
        this.byUser.sweep(this.now());
    }
}

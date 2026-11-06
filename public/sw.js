/**
 * Video streaming, service worker half (the page half is
 * src/services/stream.js).
 *
 * A <video> pointed at /stream/<file_id>/<name> asks for byte ranges as it
 * plays and seeks. Telegram is only reachable from the page (GramJS lives
 * there), so each range is passed to the tab that asked, which fetches the
 * parts from Telegram and hands the bytes back. Answers are short (a part or
 * two); the player asks again for what follows, the way it would of any
 * server that sends partial content.
 *
 * Nothing else goes through here: every other request is left to the network.
 */
const PREFIX = "/stream/";
// a range the page has not answered by then is reported as failed, so the
// player can say so instead of spinning
const ANSWER_TIMEOUT = 60000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
    event.waitUntil(self.clients.claim()),
);

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.startsWith(PREFIX)) return;
    event.respondWith(serve(event, url));
});

function parseRange(header) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? "");
    if (!match) return { start: 0, end: null };
    return {
        start: Number(match[1]),
        end: match[2] === "" ? null : Number(match[2]),
    };
}

function ask(client, message) {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(
            () => resolve({ error: "timeout" }),
            ANSWER_TIMEOUT,
        );
        channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
        };
        client.postMessage({ type: "cloudgram-stream", ...message }, [
            channel.port2,
        ]);
    });
}

async function serve(event, url) {
    const fileId = Number(url.pathname.slice(PREFIX.length).split("/")[0]);
    const { start, end } = parseRange(event.request.headers.get("range"));
    const own = event.clientId && (await self.clients.get(event.clientId));
    const clients = own
        ? [own]
        : await self.clients.matchAll({ type: "window" });
    let reply = { error: "no page" };
    // without the asking tab (rare), any tab that holds Telegram may answer
    for (const client of clients) {
        reply = await ask(client, { fileId, start, end });
        if (!reply.error) break;
    }
    if (reply.error === "range") {
        return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${reply.size}` },
        });
    }
    if (reply.error) {
        return new Response(reply.error, {
            status: reply.error === "missing" ? 404 : 503,
        });
    }
    const last = reply.start + reply.bytes.byteLength - 1;
    return new Response(reply.bytes, {
        status: 206,
        headers: {
            "Content-Type": reply.type,
            "Content-Length": String(reply.bytes.byteLength),
            "Content-Range": `bytes ${reply.start}-${last}/${reply.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
        },
    });
}

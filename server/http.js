/**
 * The HTTP layer: routing, cookies, JSON bodies and the CSRF checks.
 *
 * Kept on node:http with no framework, so the service has no dependencies to
 * install or audit on the VPS.
 */
import { createReadStream } from "node:fs";
import { createServer } from "node:http";

import { HttpError, LIMITS } from "./app.js";
import { FileReply, SHARE_LIMITS } from "./shares.js";

const ROUTES = {
    "POST /api/auth/prelogin": "prelogin",
    "POST /api/auth/login": "login",
    "POST /api/auth/setup-info": "setupInfo",
    "POST /api/auth/setup": "completeSetup",
    "POST /api/auth/logout": "logout",
    "POST /api/auth/logout-others": "logoutOthers",
    "POST /api/auth/password": "changePassword",
    "GET /api/me": "me",
    "GET /api/vault/session": "getSession",
    "PUT /api/vault/session": "putSession",
    "DELETE /api/vault/session": "deleteSession",
    "GET /api/vault/tree": "getTree",
    "PUT /api/vault/tree": "putTree",
    "POST /api/lease": "lease",
    "POST /api/lease/release": "release",
    "POST /api/shares": "shares.create",
    "POST /api/dropbox/resolve": "dropbox.resolve",
    "GET /api/shares": "shares.list",
};

// routes with ids in the path; `raw` takes the body as bytes, not JSON
const PATTERNS = [
    {
        method: "PUT",
        re: /^\/api\/shares\/([^/]+)\/chunks\/(\d+)$/,
        keys: ["id", "index"],
        handler: "shares.putChunk",
        raw: true,
    },
    {
        method: "POST",
        re: /^\/api\/shares\/([^/]+)\/complete$/,
        keys: ["id"],
        handler: "shares.complete",
    },
    {
        method: "DELETE",
        re: /^\/api\/shares\/([^/]+)$/,
        keys: ["id"],
        handler: "shares.remove",
    },
    // public: anyone holding a link
    {
        method: "GET",
        re: /^\/api\/s\/([^/]+)$/,
        keys: ["id"],
        handler: "shares.publicMeta",
    },
    {
        method: "GET",
        re: /^\/api\/s\/([^/]+)\/(\d+)$/,
        keys: ["id", "index"],
        handler: "shares.publicChunk",
    },
];

function route(method, pathname) {
    const exact = ROUTES[`${method} ${pathname}`];
    if (exact) return { handler: exact, params: {} };
    for (const pattern of PATTERNS) {
        if (pattern.method !== method) continue;
        const match = pattern.re.exec(pathname);
        if (!match) continue;
        const params = {};
        pattern.keys.forEach((key, i) => (params[key] = match[i + 1]));
        return { handler: pattern.handler, params, raw: pattern.raw };
    }
    return null;
}

function resolve(api, handler) {
    const [first, second] = handler.split(".");
    return second ? api[first][second].bind(api[first]) : api[first].bind(api);
}

function parseCookies(header) {
    const cookies = {};
    for (const part of String(header ?? "").split(";")) {
        const index = part.indexOf("=");
        if (index < 1) continue;
        cookies[part.slice(0, index).trim()] = decodeURIComponent(
            part.slice(index + 1).trim(),
        );
    }
    return cookies;
}

async function readBytes(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new HttpError(413, "too_large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function readJson(req) {
    const bytes = await readBytes(req, LIMITS.body);
    if (!bytes.length) return {};
    try {
        const body = JSON.parse(bytes.toString("utf8"));
        if (body === null || typeof body !== "object" || Array.isArray(body))
            throw new Error();
        return body;
    } catch {
        throw new HttpError(400, "bad_json");
    }
}

export function createApiServer(
    api,
    { origin, secureCookies = true, log = console } = {},
) {
    return createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const method = req.method === "HEAD" ? "GET" : req.method;
        const found = route(method, url.pathname);

        const headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        };
        const cookies = [];
        const reply = {
            cookie(name, value, maxAge) {
                cookies.push(
                    `${name}=${encodeURIComponent(
                        value,
                    )}; Path=/api; HttpOnly; SameSite=Strict` +
                        (secureCookies ? "; Secure" : "") +
                        (maxAge ? `; Max-Age=${Math.floor(maxAge)}` : ""),
                );
            },
            clearCookie(name) {
                cookies.push(
                    `${name}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0` +
                        (secureCookies ? "; Secure" : ""),
                );
            },
        };

        const send = (status, body) => {
            if (cookies.length) headers["Set-Cookie"] = cookies;
            res.writeHead(status, headers);
            res.end(JSON.stringify(body));
        };

        try {
            if (!found) throw new HttpError(404, "not_found");

            if (method !== "GET") {
                // SameSite=Strict already keeps the cookie off cross-site
                // requests; these two make a forged form post fail outright.
                const type = String(req.headers["content-type"] ?? "");
                if (found.raw) {
                    // a form can post bytes too, so binary uploads must also
                    // say where they come from
                    if (!type.startsWith("application/octet-stream"))
                        throw new HttpError(415, "bytes_required");
                    if (origin && req.headers.origin !== origin)
                        throw new HttpError(403, "bad_origin");
                } else if (!type.startsWith("application/json")) {
                    throw new HttpError(415, "json_required");
                }
                if (
                    origin &&
                    req.headers.origin &&
                    req.headers.origin !== origin
                ) {
                    throw new HttpError(403, "bad_origin");
                }
            }

            const request = {
                headers: req.headers,
                cookies: parseCookies(req.headers.cookie),
                // ufw only lets Cloudflare reach nginx, so this header is the
                // real client and cannot be forged from outside
                ip: String(
                    req.headers["cf-connecting-ip"] ??
                        req.socket.remoteAddress ??
                        "unknown",
                ),
                params: found.params,
                body: method === "GET" || found.raw ? {} : await readJson(req),
                raw: found.raw
                    ? await readBytes(req, SHARE_LIMITS.chunkBytes)
                    : undefined,
            };
            const result = await resolve(api, found.handler)(request, reply);
            if (result instanceof FileReply) {
                res.writeHead(200, {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(result.size),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                });
                if (req.method === "HEAD") return res.end();
                const stream = createReadStream(result.path);
                stream.on("error", () => res.destroy());
                stream.pipe(res);
                return;
            }
            send(200, result);
        } catch (error) {
            if (error instanceof HttpError) {
                if (error.extra?.retryAfter)
                    headers["Retry-After"] = String(error.extra.retryAfter);
                send(error.status, { error: error.code, ...error.extra });
            } else {
                log.error(error);
                send(500, { error: "internal" });
            }
        }
    });
}

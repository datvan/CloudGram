/**
 * The HTTP layer: routing, cookies, JSON bodies and the CSRF checks.
 *
 * Kept on node:http with no framework, so the service has no dependencies to
 * install or audit on the VPS.
 */
import { createServer } from "node:http";

import { HttpError, LIMITS } from "./app.js";

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
};

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

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMITS.body) throw new HttpError(413, "too_large");
        chunks.push(chunk);
    }
    if (!size) return {};
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
        const handler = ROUTES[`${method} ${url.pathname}`];

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
            if (!handler) throw new HttpError(404, "not_found");

            if (method !== "GET") {
                // SameSite=Strict already keeps the cookie off cross-site
                // requests; these two make a forged form post fail outright.
                if (
                    !String(req.headers["content-type"] ?? "").startsWith(
                        "application/json",
                    )
                ) {
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
                body: method === "GET" ? {} : await readJson(req),
            };
            send(200, await api[handler](request, reply));
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

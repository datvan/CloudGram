import { sanitizeDiag } from "../../server/diagSchema.js";
import { DIAG_LOG } from "../config/features.js";
import { UPLOAD_OWNER, LOG_OWNER } from "../config/security.js";

const randomId = (length) => {
    let id = "";
    while (id.length < length) id += Math.random().toString(36).slice(2);
    return id.slice(0, length);
};
const tab = DIAG_LOG ? randomId(8) : "";
const build = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "00000000";
let getScope = () => null;
let seq = 0;
let started = false;
let sending = false;
let blocked = null;
let lost = 0;
let lostScope = null;
let queue = [];
const ring = [];
const stages = new Map();
let stallTimer = null;

export const diagRun = () => randomId(6);
export const diagTab = tab;
export function setDiagScope(getter) {
    getScope = getter;
}

function scopeNow() {
    try {
        return getScope() || null;
    } catch {
        return null;
    }
}

function countLost(n, scope) {
    if (!scope) return;
    if (lostScope !== scope) lost = 0;
    lostScope = scope;
    lost += n;
}

function record(evt, fields, scope) {
    const ua = navigator.userAgent || "";
    const match =
        ua.match(/(?:Edg|OPR)\/(\d+)/i) ||
        ua.match(/(?:Chrome|Firefox|Version)\/(\d+)/i);
    const name = match ? match[0].split("/")[0].toLowerCase() : "unknown";
    const br = `${name === "version" ? "safari" : name}/${match?.[1] || "0"}`;
    const context = {
        evt,
        seq: ++seq,
        t: performance.now(),
        ts: Date.now(),
        tab,
        build,
        br,
        fsa: "showOpenFilePicker" in window,
        uploadOwner: UPLOAD_OWNER,
        logOwner: LOG_OWNER,
    };
    const result = sanitizeDiag({ ...context, ...fields, ...context });
    countLost(result.dropped, scope);
    if (!result.event) return;
    ring.push(result.event);
    if (ring.length > 500) ring.shift();
    queue.push({ event: result.event, scope });
    if (queue.length > 500) {
        const removed = queue.shift();
        countLost(1, removed.scope);
    }
}

function globalError(error) {
    try {
        const name = error?.name;
        diag("err.global", {
            errName:
                typeof name === "string" && /^[A-Z][A-Za-z]{2,39}$/.test(name)
                    ? name
                    : "Error",
        });
    } catch {
        diag("err.global", { errName: "Error" });
    }
}

function start(scope) {
    started = true;
    window.addEventListener("error", (event) => globalError(event.error));
    window.addEventListener("unhandledrejection", (event) =>
        globalError(event.reason),
    );
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
    });
    setInterval(flush, 5000);
    record("diag.start", {}, scope);
}

export function diag(evt, fields = {}) {
    if (!DIAG_LOG) return;
    try {
        const stage = stages.get(fields.run);
        if (stage?.open) stage.last = Date.now();
        const scope = scopeNow();
        if (!started) start(scope);
        record(evt, fields, scope);
    } catch {
        countLost(1, scopeNow());
    }
}

export function swallow(site, fallback) {
    return (error) => {
        try {
            let name, code;
            try {
                name = error?.name;
            } catch {
                // Error properties may be hostile getters.
            }
            try {
                code = error?.code;
            } catch {
                // Ignore inaccessible error codes.
            }
            diag("err.swallowed", {
                site,
                errName:
                    typeof name === "string" &&
                    /^[A-Z][A-Za-z]{2,39}$/.test(name)
                        ? name
                        : "Error",
                ...(typeof code === "string" &&
                /^[A-Z][A-Z0-9_]{2,39}$/.test(code)
                    ? { errCode: code }
                    : {}),
            });
        } catch {
            // Diagnostics must never change the fallback.
        }
        return fallback;
    };
}

function stopStallTimer() {
    if (stallTimer !== null && ![...stages.values()].some((s) => s.open)) {
        clearInterval(stallTimer);
        stallTimer = null;
    }
}

export function diagStage(run, stage) {
    if (!DIAG_LOG) return;
    try {
        const previous = stages.get(run);
        stages.set(run, {
            open: true,
            stage,
            last: Date.now(),
            count: previous?.count || 0,
        });
        if (stallTimer === null)
            stallTimer = setInterval(() => {
                for (const [id, current] of stages) {
                    const idleMs = Date.now() - current.last;
                    if (current.open && current.count < 4 && idleMs >= 15000) {
                        current.count++;
                        diag("run.stall", {
                            run: id,
                            stage: current.stage,
                            idleMs,
                        });
                    }
                }
            }, 1000);
    } catch {
        // Diagnostics must never interrupt the app.
    }
}

export function diagStageEnd(run) {
    try {
        const stage = stages.get(run);
        if (stage) stage.open = false;
        stopStallTimer();
    } catch {
        // Diagnostics must never interrupt the app.
    }
}

export function diagRunEnd(run) {
    try {
        stages.delete(run);
        stopStallTimer();
    } catch {
        // Diagnostics must never interrupt the app.
    }
}

async function flush() {
    if (sending) return;
    sending = true;
    try {
        let scope = scopeNow();
        queue = queue.filter((item) => scope && item.scope === scope);
        if (lostScope !== scope) {
            lost = 0;
            lostScope = scope;
        }
        if (!scope || blocked === scope) return;
        blocked = null;
        if (lost) {
            const n = lost;
            lost = 0;
            record("diag.lost", { n }, scope);
        }
        while (queue.length) {
            if (scopeNow() !== scope) break;
            const events = [];
            while (queue.length && events.length < 100) {
                const next = queue[0];
                if (
                    JSON.stringify({ events: [...events, next.event] }).length >
                    24 * 1024
                )
                    break;
                events.push(queue.shift().event);
            }
            if (!events.length) break;
            try {
                const response = await fetch("/api/log", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ events }),
                    keepalive: true,
                });
                if (!response.ok) {
                    if (response.status === 401) blocked = scope;
                    throw new Error("diagnostics rejected");
                }
            } catch {
                countLost(events.length, scope);
                break;
            }
            scope = scopeNow();
            queue = queue.filter((item) => scope && item.scope === scope);
        }
    } catch {
        // Diagnostics must never interrupt the app.
    } finally {
        sending = false;
    }
}

export function downloadDiag() {
    try {
        return JSON.stringify(ring);
    } catch {
        return "[]";
    }
}

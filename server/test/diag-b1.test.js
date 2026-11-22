import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { sanitizeDiag } from "../diagSchema.js";

async function load(ua = "Chrome/131", throws = false) {
    let source = (
        await readFile(
            new URL("../../src/services/diag.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    if (throws)
        source = source
            .replace("export function diag(", "export function diag(")
            .replace(
                "function diag(evt, fields = {}) {",
                'function diag(evt, fields = {}) { throw new Error("test");',
            );
    let now = 0;
    let next = 0;
    const timers = new Map();
    const context = vm.createContext({
        sanitizeDiag,
        DIAG_LOG: true,
        UPLOAD_OWNER: true,
        LOG_OWNER: true,
        navigator: { userAgent: ua },
        window: { addEventListener() {} },
        document: { addEventListener() {} },
        performance: { now: () => now },
        Date: { now: () => now },
        setInterval: (fn, ms) => {
            const id = ++next;
            timers.set(id, { fn, ms, at: now + ms });
            return id;
        },
        clearInterval: (id) => timers.delete(id),
    });
    const api = vm.runInContext(
        `${source}\n;({diag, swallow, diagStage, diagStageEnd, diagRunEnd, downloadDiag})`,
        context,
    );
    function advance(ms) {
        const end = now + ms;
        while (true) {
            const due = [...timers.entries()]
                .filter(([, t]) => t.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            due[1].at += due[1].ms;
            due[1].fn();
        }
        now = end;
    }
    return { api, advance, timers };
}

test("swallow returns each fallback and emits only safe fields", async () => {
    const { api } = await load();
    const sites = {
        "driveApp.permission": null,
        "pickers.writeFolder.resolve": null,
        "pickers.writeFolder.permission": null,
        "pickers.writeFolder.picker": null,
        "pickers.roots.writePermission": null,
        "pickers.askToWrite": { allowed: false },
        "pickers.removeFolders": undefined,
        "pickers.roots.permission": "denied",
        "uploadQueue.writePermission": undefined,
        "uploadLog.tabLock": undefined,
        "uploadLog.loadFolders": undefined,
        "uploadLog.decrypt": undefined,
        "uploadLog.liveTabs": undefined,
        "drive.scheduleFlush": undefined,
        "drive.retryFlush": undefined,
        "drive.setFileId": undefined,
        "account.leaseRefresh": undefined,
        "account.leasePoll": undefined,
        "account.heartbeat": undefined,
    };
    for (const [site, fallback] of Object.entries(sites)) {
        assert.equal(
            api.swallow(
                site,
                fallback,
            )({ name: "TypeError", code: "BAD_CODE", message: "file.jpg" }),
            fallback,
        );
    }
    const events = JSON.parse(api.downloadDiag()).filter(
        (e) => e.evt === "err.swallowed",
    );
    assert.equal(events.length, Object.keys(sites).length);
    for (const event of events) {
        assert.equal(sanitizeDiag(event).dropped, 0);
        assert.equal(JSON.stringify(event).includes("file.jpg"), false);
    }
    const failing = await load("Chrome/1", true);
    assert.equal(
        failing.api.swallow("driveApp.permission", null)(new Error()),
        null,
    );
    assert.equal(
        api.swallow(
            "driveApp.permission",
            "fallback",
        )(
            new Proxy(
                {},
                {
                    get() {
                        throw Error();
                    },
                },
            ),
        ),
        "fallback",
    );
});

test("watchdog follows idle time and releases its interval", async () => {
    const h = await load();
    h.api.diagStage("run123", "scan");
    h.advance(14999);
    assert.equal(JSON.parse(h.api.downloadDiag()).length, 0);
    h.advance(1);
    h.advance(15000);
    h.api.diag("upload.entries.start", { run: "run123", n: 1 });
    h.advance(14000);
    assert.equal(
        JSON.parse(h.api.downloadDiag()).filter((e) => e.evt === "run.stall")
            .length,
        2,
    );
    h.advance(31000);
    assert.equal(
        JSON.parse(h.api.downloadDiag()).filter((e) => e.evt === "run.stall")
            .length,
        4,
    );
    h.api.diagStageEnd("run123");
    assert.equal(
        [...h.timers.values()].some((t) => t.ms === 1000),
        false,
    );
    h.advance(30000);
    assert.equal(
        JSON.parse(h.api.downloadDiag()).filter((e) => e.evt === "run.stall")
            .length,
        4,
    );
    h.api.diagStage("run123", "perm");
    h.advance(15000);
    assert.equal(
        JSON.parse(h.api.downloadDiag()).filter((e) => e.evt === "run.stall")
            .length,
        4,
    );
    h.api.diagRunEnd("run123");
    assert.equal(
        [...h.timers.values()].some((t) => t.ms === 1000),
        false,
    );
});

for (const [ua, expected] of [
    ["Chrome/131.0", "chrome/131"],
    ["Chrome/131.0 Edg/132.0", "edg/132"],
    ["Chrome/131.0 OPR/115.0", "opr/115"],
    ["Firefox/133.0", "firefox/133"],
    ["Version/18.0 Safari/605", "safari/18"],
])
    test(`browser ${expected}`, async () => {
        const { api } = await load(ua);
        api.diag("diag.start");
        assert.equal(JSON.parse(api.downloadDiag()).at(-1).br, expected);
    });

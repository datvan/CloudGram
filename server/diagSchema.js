// Only explicitly described values can cross the diagnostics boundary.
const EVENTS = {
    "diag.start": {},
    "diag.lost": { n: "num" },
    "err.global": { errName: "errName" },
    "upload.start": {
        via: ["drop", "picker", "input", "pieces"],
        nRoots: "num",
    },
    "upload.direct.fallback": {},
    "read.direct.fallback": {},
    "upload.scan.progress": { files: "num", sizeB: "sizeB" },
    "upload.scan.done": { files: "num", ms: "num" },
    "upload.scan.fail": { errName: "errName" },
    "upload.mode.open": {
        total: "num",
        media: "num",
        removable: "bool",
        fsa: "bool",
    },
    "upload.mode.answer": {
        answer: ["start", "cancel"],
        asMedia: "bool",
        removeOriginal: "bool",
        ms: "num",
    },
    "upload.perm.wait": {
        kind: ["roots", "folder", "picker"],
        n: "num",
        q: ["granted", "prompt", "denied", "unknown"],
        act: "bool",
        focus: "bool",
    },
    "upload.perm.result": {
        result: ["granted", "denied", "skipped", "threw", "outside"],
        ms: "num",
        outside: "num",
        errName: "errName",
    },
    "upload.step": {
        step: [
            "loadFolders",
            "resolveStored",
            "queryStored",
            "saveFolders",
            "resolveEach",
            "picker",
            "sameEntry",
        ],
        phase: ["start", "end", "fail"],
        ms: "num",
        n: "num",
        errName: "errName",
    },
    "upload.entries.start": { n: "num" },
    "upload.entries.plan": {
        queued: "num",
        replaced: "num",
        renamed: "num",
        linked: "num",
        skipped: "num",
        oversize: "num",
        unfinished: "num",
        elsewhere: "num",
    },
    "upload.entries.stop": {
        reason: ["cancel", "scope", "empty", "enqueueFailed"],
    },
    "upload.enqueue": {
        sizeB: "sizeB",
        ok: "bool",
        kind: ["new", "resume", "replace", "rename"],
    },
    "queue.pump": {
        state: ["offline", "slot", "idle", "scopeMismatch"],
        active: "num",
        queued: "num",
    },
    "file.start": { sizeB: "sizeB", parts: "num" },
    "file.part.retry": { n: "num", errName: "errName" },
    "file.done": { ms: "num", retries: "num" },
    "file.fail": {
        errName: "errName",
        stage: ["read", "encrypt", "send", "save", "other"],
    },
    "thumb.fail": {
        kind: ["image", "video"],
        reason: [
            "unsupported",
            "too_large",
            "timeout",
            "decode",
            "no_frame",
            "canvas",
            "heic_fallback_off",
            "store",
        ],
        mime: /^(?:image|video)\/[a-z0-9][a-z0-9.+-]{0,63}$/,
        size: ["<10M", "<100M", "<1G", ">=1G"],
    },
    "thumbs.backfill": { ok: "num", fail: "num", skipped: "num" },
    "thumbs.migrate.batch": { n: "num", ms: "num", kb: "num" },
    "thumbs.migrate.done": { n: "num", skipped: "num" },
    "thumbs.migrate.stop": {
        n: "num",
        skipped: "num",
        reason: ["fail", "closed"],
    },
    "tree.cache": { hit: "bool", shards: "num", ms: "num" },
    "tree.save": { ok: "bool", ms: "num", retries409: "num" },
    "tree.stats": {
        records: "num",
        tombstones: "num",
        folders: "num",
        files: "num",
        thumbs: "num",
        recordBytes: "num",
        name: "num",
        thumbData: "num",
        thumbnailBlob: "num",
        storyboard: "num",
        enc: "num",
        parts: "num",
        share: "num",
        labels: "num",
        other: "num",
    },
    "tree.stats.max": {
        recordBytes: "num",
        name: "num",
        thumbData: "num",
        thumbnailBlob: "num",
        storyboard: "num",
        enc: "num",
        parts: "num",
        share: "num",
        labels: "num",
        other: "num",
    },
    "conn.state": {
        state: ["connecting", "ready", "offline", "leaseLost", "leaseOk"],
        leaseOk: "bool",
    },
    "conn.heartbeatGap": {
        ms: "num",
        visibility: ["visible", "hidden", "prerender"],
    },
    "remove.original": {
        result: ["deleted", "kept", "changed", "locked", "permission"],
    },
    "run.finish": {
        queued: "num",
        resumed: "num",
        replaced: "num",
        renamed: "num",
        linked: "num",
        skipped: "num",
        ms: "num",
        reason: ["none", "cancel", "scope", "enqueueFailed", "other"],
        notice: ["none", "info", "warning", "error", "success"],
    },
    "ui.notice": {
        sev: ["info", "warning", "error", "success"],
        kind: [
            "noRepairableVideo",
            "openTrashed",
            "actionFailed",
            "thumbnailCreated",
            "thumbnailFailed",
            "trashed",
            "restored",
            "deleted",
            "moved",
            "uploadFailed",
            "nothingQueued",
            "uploadStarted",
            "scanFailed",
            "uploadBusy",
            "sessionsLoggedOut",
            "dialogMoved",
            "passwordChanged",
            "dialogNotice",
            "resumeNotice",
        ],
    },
    "err.swallowed": {
        site: [
            "driveApp.permission",
            "pickers.writeFolder.resolve",
            "pickers.writeFolder.permission",
            "pickers.writeFolder.picker",
            "pickers.roots.writePermission",
            "pickers.askToWrite",
            "pickers.removeFolders",
            "pickers.roots.permission",
            "uploadQueue.writePermission",
            "uploadLog.tabLock",
            "uploadLog.loadFolders",
            "uploadLog.decrypt",
            "uploadLog.liveTabs",
            "drive.scheduleFlush",
            "drive.retryFlush",
            "drive.setFileId",
            "account.leaseRefresh",
            "account.leasePoll",
            "account.heartbeat",
        ],
        errName: "errName",
    },
    "run.stall": {
        stage: ["scan", "modeDialog", "perm", "treeSave", "offline", "other"],
        idleMs: "num",
    },
};

const CONTEXT = {
    seq: "num",
    t: "num",
    ts: "timestamp",
    tab: /^[0-9a-z]{4,12}$/,
    run: /^[0-9a-z]{4,12}$/,
    file: /^[0-9a-z]{4,12}$/,
    req: /^[0-9a-z]{4,12}$/,
    br: /^[a-z]+\/\d+$/,
    build: /^[0-9a-f]{7,12}(-dirty)?$/,
    fsa: "bool",
    uploadOwner: "bool",
    logOwner: "bool",
    errCode: /^[A-Z][A-Z0-9_]{2,39}$/,
};

const ERROR_NAME = /^[A-Z][A-Za-z]{2,39}$/;

export function sanitizeDiag(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return { event: null, dropped: 1 };
    const schema = Object.hasOwn(EVENTS, input.evt) && EVENTS[input.evt];
    if (!schema) return { event: null, dropped: 1 };
    const event = { evt: input.evt };
    let dropped = 0;
    let count = 0;
    for (const [key, value] of Object.entries(input)) {
        if (key === "evt") continue;
        const rule =
            input.evt === "thumb.fail" && ["file", "run", "req"].includes(key)
                ? null
                : Object.hasOwn(schema, key)
                ? schema[key]
                : Object.hasOwn(CONTEXT, key)
                ? CONTEXT[key]
                : null;
        if (!rule || count >= 24) {
            dropped++;
            continue;
        }
        if (
            rule === "num" &&
            typeof value === "number" &&
            Number.isFinite(value)
        ) {
            event[key] = Math.max(0, Math.min(1e12, value));
        } else if (
            rule === "timestamp" &&
            Number.isSafeInteger(value) &&
            value >= 0
        ) {
            event[key] = value;
        } else if (
            rule === "sizeB" &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 60
        ) {
            event[key] = value;
        } else if (rule === "bool" && typeof value === "boolean") {
            event[key] = value;
        } else if (
            typeof value === "string" &&
            ((Array.isArray(rule) && rule.includes(value)) ||
                (rule === "errName" && ERROR_NAME.test(value)) ||
                (rule instanceof RegExp && rule.test(value)))
        ) {
            event[key] = value;
        } else {
            dropped++;
            continue;
        }
        count++;
    }
    return { event, dropped };
}

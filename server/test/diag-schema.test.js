import assert from "node:assert/strict";
import { sanitizeDiag } from "../diagSchema.js";

const secretValues = [
    "IMG_1234.jpg",
    "https://example.invalid/?token=secret",
    "x".repeat(1000),
    { path: "/private/file" },
    new Error("/private/file"),
];
for (const value of secretValues) {
    const result = sanitizeDiag({
        evt: "err.global",
        errName: value,
        secret: value,
    });
    assert.deepEqual(result.event, { evt: "err.global" });
    assert.equal(result.dropped, 2);
}
assert.deepEqual(sanitizeDiag({ evt: "unknown", n: 1 }).event, null);
assert.deepEqual(sanitizeDiag({ evt: "diag.lost", n: 2e12 }).event, {
    evt: "diag.lost",
    n: 1e12,
});
assert.deepEqual(
    sanitizeDiag({ evt: "err.global", errName: "AbortError" }).event,
    {
        evt: "err.global",
        errName: "AbortError",
    },
);
console.log("diagnostic schema tests passed");

const samples = {
    "upload.start": { via: "drop", nRoots: 1 },
    "upload.scan.progress": { files: 1, sizeB: 60 },
    "upload.scan.done": { files: 1, ms: 1 },
    "upload.scan.fail": { errName: "Error" },
    "upload.mode.open": { total: 1, media: 1, removable: true, fsa: true },
    "upload.mode.answer": {
        answer: "start",
        asMedia: true,
        removeOriginal: false,
        ms: 1,
    },
    "upload.perm.wait": {
        kind: "roots",
        n: 1,
        q: "prompt",
        act: true,
        focus: true,
    },
    "upload.perm.result": {
        result: "threw",
        ms: 1,
        outside: 1,
        errName: "Error",
    },
    "upload.entries.start": { n: 1 },
    "upload.entries.plan": {
        queued: 1,
        replaced: 1,
        renamed: 1,
        linked: 1,
        skipped: 1,
        oversize: 1,
        unfinished: 1,
        elsewhere: 1,
    },
    "upload.entries.stop": { reason: "cancel" },
    "upload.enqueue": { file: "file12", sizeB: 1, ok: true, kind: "new" },
    "queue.pump": { state: "idle", active: 0, queued: 0 },
    "file.start": { file: "file12", sizeB: 1, parts: 1 },
    "file.part.retry": {
        file: "file12",
        n: 1,
        errName: "Error",
        errCode: "ERR_CODE",
    },
    "file.done": { file: "file12", ms: 1, retries: 1 },
    "file.fail": {
        file: "file12",
        errName: "Error",
        errCode: "ERR_CODE",
        stage: "read",
    },
    "tree.save": { ok: true, ms: 1, retries409: 0 },
    "conn.state": { state: "ready", leaseOk: true },
    "remove.original": { file: "file12", result: "kept" },
    "run.finish": {
        queued: 1,
        resumed: 1,
        replaced: 1,
        renamed: 1,
        linked: 1,
        skipped: 1,
        ms: 1,
        reason: "none",
        notice: "info",
    },
    "ui.notice": { sev: "info", kind: "uploadStarted" },
    "err.swallowed": {
        site: "pickers.writeFolder.resolve",
        errName: "Error",
        errCode: "ERR_CODE",
    },
    "run.stall": { stage: "scan", idleMs: 15000 },
};
for (const [evt, fields] of Object.entries(samples)) {
    const input = { evt, run: "run123", ...fields };
    assert.deepEqual(sanitizeDiag(input), { event: input, dropped: 0 }, evt);
}
assert.equal(
    sanitizeDiag({
        evt: "upload.start",
        via: "file.jpg",
        nRoots: "1",
        extra: true,
    }).dropped,
    3,
);
assert.equal(
    sanitizeDiag({ evt: "run.stall", stage: "bad", idleMs: 1 }).dropped,
    1,
);
assert.equal(
    sanitizeDiag({ evt: "upload.scan.progress", sizeB: 61 }).dropped,
    1,
);

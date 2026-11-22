import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatLogs } from "./log-formatter.mjs";
import { main, parseArgs } from "./vps-logs.mjs";

const event = (tab, run, evt, ts) => ({
    evt,
    tab,
    ...(run ? { run } : {}),
    ts,
});
const a = event("tab1", "run1", "run.start", 1000);
const b = event("tab1", "run1", "file.done", 2000);
const c = event("tab1", "run1", "run.finish", 3000);
const d = event("tab2", "run2", "upload.perm.wait", 1100);
const e = event("tab2", "run2", "run.stall", 4000);
const f = event("tab2", null, "err.global", 5000);
const api = { src: "api", ts: 1500, m: "GET", route: "me", status: 200 };
const error = {
    src: "api",
    lvl: "error",
    ts: 2500,
    errName: "Error",
    stack: [],
};
const failure = { src: "api", ts: 2600, route: "failed", status: 503 };
const input = [
    a,
    { src: "client", acct: "abcd1234", ev: b },
    c,
    d,
    e,
    f,
    api,
    error,
    failure,
    "garbage",
];
const result = formatLogs(input);
assert.match(result, /tab tab1[\s\S]*\+1\.000s  file.done[\s\S]*run run1/);
assert.match(result, /LAST STAGE REACHED: run.finish 0\.000s/);
assert.match(result, /NO run.finish: stopped after run.stall/);
assert.match(result, /LAST STAGE REACHED: run.stall 1\.000s/);
assert.match(result, /SUMMARY: file.done=1 file.fail=0 err.swallowed=0/);
assert.match(result, /server[\s\S]*\+0\.500s  access[\s\S]*\+1\.500s  error/);
assert.match(result, /skipped=1/);
assert.match(formatLogs([JSON.stringify([a, c])]), /run.finish/);
const filtered = formatLogs(input, { tab: "tab2", run: "run2" });
assert.doesNotMatch(filtered, /tab tab1/);
assert.match(filtered, /run run2/);
const errors = formatLogs(input, { errors: true });
assert.match(errors, /err.global/);
assert.match(errors, /server[\s\S]*error/);
assert.match(errors, /route=failed status=503/);
assert.doesNotMatch(errors, /route=me|upload.perm.wait/);
assert.throws(
    () => parseArgs(["--since", "1 hour ago; whoami"]),
    /Invalid --since/,
);

const context = {
    tab: "q1w2e3r4",
    build: "11a2a2a0-dirty",
    br: "chrome/131",
    fsa: true,
    uploadOwner: true,
    logOwner: true,
};
const sample = [
    { ...context, evt: "diag.start", seq: 13, t: 0, ts: 1000 },
    { ...context, evt: "run.start", run: "run1", seq: 14, t: 1000, ts: 3000 },
    {
        ...context,
        evt: "file.done",
        run: "run1",
        seq: 17,
        t: 2000,
        ts: 2000,
        file: "file1",
    },
];
const timeline = formatLogs(sample);
assert.match(timeline, /first 12 events not received/);
assert.match(timeline, /2 events missing \(seq 15-16/);
assert.ok(timeline.indexOf("run.start") < timeline.indexOf("file.done"));
assert.match(
    timeline,
    /tab q1w2e3r4  build 11a2a2a0-dirty  chrome\/131  fsa=true/,
);
assert.doesNotMatch(timeline, /seq=13|uploadOwner=/);
assert.match(formatLogs(sample, { verbose: true }), /seq=13/);
assert.equal(parseArgs(["--verbose"]).verbose, true);
assert.match(timeline, /SUMMARY:.*tabs=1.*runs=1/);
assert.match(timeline, /LAST STAGE REACHED: file.done 0\.000s/);
assert.match(formatLogs([failure]), /!!.*status=503/);
assert.equal((timeline.match(/^tab q1w2e3r4/gm) || []).length, 1);
assert.match(
    formatLogs([{ ...sample[0], evt: "diag.lost", n: 4 }]),
    /!! diag.lost  n=4/,
);
const verbose = formatLogs(sample, { verbose: true });
for (const key of [
    "ts",
    "t",
    "tab",
    "build",
    "br",
    "fsa",
    "uploadOwner",
    "logOwner",
    "seq",
])
    assert.match(verbose, new RegExp(`${key}=`));
assert.match(
    formatLogs([
        {
            src: "api",
            ts: 1000,
            route: "x",
            status: 404,
            ms: 5,
            code: "FAIL",
            errName: "Error",
            errCode: "BAD",
            stack: ["handler:1:2"],
        },
    ]),
    /!! access  route=x status=404 ms=5 code=FAIL errName=Error errCode=BAD\n    handler:1:2/,
);
const demo = [
    { ...context, evt: "diag.start", seq: 1, ts: 1000 },
    { ...context, evt: "file.start", seq: 2, ts: 2000, file: "f1" },
    { ...context, evt: "file.done", seq: 4, ts: 3000, file: "f1" },
    { ...context, br: "chrome/132", evt: "diag.lost", seq: 5, ts: 4000, n: 1 },
    { ...context, br: "chrome/132", evt: "run.finish", seq: 6, ts: 5000 },
    { ...context, tab: "z9y8x7w6", evt: "diag.start", seq: 1, ts: 6000 },
].map((ev) => ({ src: "client", acct: "ab12cd34", ev }));
const demoOutput = formatLogs(demo);
assert.equal((demoOutput.match(/^tab /gm) || []).length, 3);
assert.equal((demoOutput.match(/^  \+.*s  /gm) || []).length, 6);
assert.match(demoOutput, /1 events missing \(seq 3-3/);
if (process.env.SHOW_LOG_SAMPLE === "1") console.log(demoOutput);

const dir = await mkdtemp(path.join(os.tmpdir(), "cloudgram-logs-"));
try {
    const marker = "PRIVATE_MARKER_3984";
    await writeFile(
        path.join(dir, ".env"),
        `DEPLOY_HOST=${marker}\nOTHER=${marker}\n`,
    );
    let output = "";
    const sink = {
        write: (text) => {
            output += text;
        },
    };
    const status = await main([], {
        env: {},
        base: dir,
        stdout: sink,
        stderr: sink,
        runner: async () => {
            throw { code: 42 };
        },
    });
    assert.equal(status, 1);
    assert.match(output, /SSH failed \(exit code 42\)/);
    assert.ok(!output.includes(marker));
    const filename = path.join(dir, "download.json");
    await writeFile(filename, JSON.stringify([a, c]));
    output = "";
    assert.equal(
        await main(["--file", filename], { stdout: sink, stderr: sink }),
        0,
    );
    assert.match(output, /run.finish/);
    output = "";
    assert.equal(
        await main(["--file", filename, "--raw"], {
            stdout: sink,
            stderr: sink,
        }),
        0,
    );
    assert.equal(output, JSON.stringify([a, c]));
} finally {
    await rm(dir, { recursive: true, force: true });
}
console.log("vps-logs tests passed");

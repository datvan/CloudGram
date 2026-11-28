import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { canRepair, REPAIR_MAX } from "../../src/services/convert.js";
import { repairVideo } from "../../src/services/convert.js";
import { realDeps, replaceRecord } from "../../src/services/reencrypt.js";

const repairSource = readFileSync(
    new URL("../../src/services/repairVideo.js", import.meta.url),
    "utf8",
)
    .replace(/^import .*;\s*$/gm, "")
    .replace("export async function", "async function");
const repairContext = {
    canRepair,
    repairVideo,
    realDeps,
    replaceRecord,
    uploadScope: () => null,
    DOMException,
};
vm.runInNewContext(
    `${repairSource}\nthis.repairRecord = repairRecord;`,
    repairContext,
);
const { repairRecord } = repairContext;

const record = {
    id: "a",
    type: "file",
    file_id: 1,
    name: "film.mkv",
    size: 20,
    mime: "video/x-matroska",
};
function fixture(input = record) {
    let current = { ...input };
    let scope = {};
    const events = [];
    const other = [];
    const deps = {
        client: {},
        uploadScope: () => scope,
        readPlain: async () => new Blob(["old"]),
        repairVideo: async () => new Blob(["repaired"], { type: "video/mp4" }),
        uploadEncrypted: async (r, blob, options) => {
            events.push(["upload", r.name, options.resume.encrypted]);
            return {
                message: { id: 10 },
                changes: options.resume.encrypted
                    ? { enc: { key: "new" } }
                    : { sentAs: "video" },
            };
        },
        update: (id, changes) => {
            events.push("update");
            current = { ...current, ...changes };
            return current;
        },
        flush: async () => {
            events.push("flush");
        },
        getSnapshot: () => ({ records: [current, ...other] }),
        deleteMessages: async (client, ids) => {
            events.push(["delete", ids]);
        },
    };
    return {
        deps,
        events,
        other,
        current: () => current,
        switchScope: () => {
            scope = {};
        },
        run: (options = {}) => repairRecord(input, { deps, ...options }),
    };
}

test("canRepair accepts one video message within limit", () => {
    assert.equal(canRepair(record), true);
    assert.equal(
        canRepair({ ...record, name: "video.mp4", mime: "video/mp4" }),
        true,
    );
    assert.equal(
        canRepair({
            ...record,
            name: "x",
            mime: "video/mp4",
            size: REPAIR_MAX,
        }),
        true,
    );
    for (const changes of [
        { type: "folder" },
        { file_id: null },
        { size: REPAIR_MAX + 1 },
        { name: "photo.jpg", mime: "image/jpeg" },
        { name: "x", mime: "text/plain" },
        { parts: [{ id: 1 }, { id: 2 }] },
        { pieces: [1, 2] },
    ])
        assert.equal(canRepair({ ...record, ...changes }), false);
});

for (const encrypted of [false, true])
    test(`repair preserves encryption: ${encrypted}`, async () => {
        const f = fixture({
            ...record,
            enc: encrypted ? { key: "old" } : undefined,
        });
        await f.run();
        assert.deepEqual(f.events, [
            ["upload", "film.mp4", encrypted],
            "update",
            "flush",
            ["delete", [1]],
        ]);
        assert.equal(f.current().size, 8);
        assert.equal(f.current().mime, "video/mp4");
        assert.deepEqual(
            f.current().enc,
            encrypted ? { key: "new" } : undefined,
        );
    });

test("abort before swap deletes uploaded message", async () => {
    const f = fixture();
    const controller = new AbortController();
    const upload = f.deps.uploadEncrypted;
    f.deps.uploadEncrypted = async (...args) => {
        const result = await upload(...args);
        controller.abort();
        return result;
    };
    await assert.rejects(f.run({ signal: controller.signal }), {
        name: "AbortError",
    });
    assert.equal(f.current().file_id, 1);
    assert.deepEqual(f.events.at(-1), ["delete", [10]]);
});

test("save failure restores original and deletes replacement", async () => {
    const f = fixture();
    let calls = 0;
    f.deps.flush = async () => {
        if (!calls++) throw new Error("save failed");
    };
    await assert.rejects(f.run(), /save failed/);
    assert.equal(f.current().file_id, 1);
    assert.equal(f.current().name, record.name);
    assert.deepEqual(f.events.at(-1), ["delete", [10]]);
});

test("shared original stays", async () => {
    const f = fixture();
    f.other.push({ id: "b", file_id: 1 });
    await f.run();
    assert.equal(
        f.events.some((e) => Array.isArray(e) && e[0] === "delete"),
        false,
    );
});

test("scope change stops before swap or cleanup", async () => {
    const f = fixture();
    const upload = f.deps.uploadEncrypted;
    f.deps.uploadEncrypted = async (...args) => {
        const result = await upload(...args);
        f.switchScope();
        return result;
    };
    await assert.rejects(f.run(), { name: "AbortError" });
    assert.equal(f.current().file_id, 1);
    assert.equal(f.events.includes("update"), false);
    assert.equal(
        f.events.some((e) => Array.isArray(e) && e[0] === "delete"),
        false,
    );
});

test("ffmpeg repair selects codecs and validates output", async () => {
    let source = readFileSync(
        new URL("../../src/services/convert.js", import.meta.url),
        "utf8",
    );
    source = source
        .replace(
            /const \[\{ FFmpeg \}, coreURL, wasmURL\] = await Promise\.all\(\[[\s\S]*?\]\);/,
            "const { FFmpeg, coreURL, wasmURL } = fake;",
        )
        .replaceAll("export ", "");
    const calls = [];
    let codec = "h264";
    let audio = true;
    let result = 0;
    let output = new Uint8Array([1]);
    class FFmpeg {
        on(event, fn) {
            if (event === "log") this.log = fn;
        }
        async load() {}
        async writeFile() {}
        terminate() {}
        async exec(args) {
            calls.push(args);
            if (args.length === 2) {
                this.log({
                    message: `Video: ${codec}\n${audio ? "Audio: aac" : ""}`,
                });
                return 1;
            }
            return result;
        }
        async readFile() {
            return output;
        }
    }
    const context = { fake: { FFmpeg }, Blob, Uint8Array };
    vm.runInNewContext(`${source}\nthis.repairVideo = repairVideo;`, context);
    await context.repairVideo(new Blob(["x"]), "x.mp4");
    assert.deepEqual(Array.from(calls.at(-1)).slice(0, 6), [
        "-err_detect",
        "ignore_err",
        "-i",
        "in.mp4",
        "-c:v",
        "copy",
    ]);
    assert.ok(calls.at(-1).includes("128k"));
    codec = "vp9";
    audio = false;
    await context.repairVideo(new Blob(["x"]), "x.webm");
    assert.ok(calls.at(-1).includes("libx264"));
    assert.ok(calls.at(-1).includes("-an"));
    result = 1;
    await assert.rejects(context.repairVideo(new Blob(["x"]), "x.mp4"));
    result = 0;
    output = new Uint8Array();
    await assert.rejects(context.repairVideo(new Blob(["x"]), "x.mp4"));
});

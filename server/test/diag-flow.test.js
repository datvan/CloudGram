import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { sanitizeDiag } from "../diagSchema.js";

async function load(throws = false, folders = [], windowExtra = {}) {
    const source = async (path) =>
        (await readFile(new URL(path, import.meta.url), "utf8"))
            .replace(/^import [\s\S]*?;\r?\n/gm, "")
            .replace(/\bexport /g, "");
    let logger = await source("../../src/services/diag.js");
    if (throws)
        logger = logger.replace(
            "function diag(evt, fields = {}) {",
            'function diag(evt, fields = {}) { throw new Error("injected");',
        );
    const pickers = await source("../../src/utils/pickers.js");
    let now = 0;
    let next = 0;
    const timers = new Map();
    const context = vm.createContext({
        sanitizeDiag,
        DIAG_LOG: true,
        UPLOAD_OWNER: false,
        LOG_OWNER: false,
        navigator: {
            userAgent: "Chrome/131",
            userActivation: { isActive: true },
        },
        window: { addEventListener() {}, ...windowExtra },
        document: { addEventListener() {}, hasFocus: () => true },
        performance: { now: () => now },
        Date: { now: () => now },
        setInterval: (fn, ms) => {
            const id = ++next;
            timers.set(id, { fn, ms, at: now + ms });
            return id;
        },
        clearInterval: (id) => timers.delete(id),
        setTimeout: (fn, ms) => {
            const id = ++next;
            timers.set(id, { fn, ms, at: now + ms, once: true });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        uploadScope: () => ({}),
        loadFolders: async () => folders,
        saveFolders: async () => {},
        uuid4: () => "id",
    });
    const api = vm.runInContext(
        `${logger}\n${pickers}\n;({askToWrite, waitForWrite, writeFolderFor, downloadDiag})`,
        context,
    );
    const advance = (ms) => {
        const end = now + ms;
        while (true) {
            const due = [...timers.entries()]
                .filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            if (due[1].once) timers.delete(due[0]);
            else due[1].at += due[1].ms;
            due[1].fn();
        }
        now = end;
    };
    return { api, advance, events: () => JSON.parse(api.downloadDiag()) };
}

const entry = (requestPermission) => ({
    file: { name: "secret-token-example.jpg" },
    handle: {
        root: {
            kind: "file",
            name: "secret-token-example.jpg",
            queryPermission: async () => "prompt",
            requestPermission,
        },
    },
});

test("pending permission reports a stall", async () => {
    const { api, advance, events } = await load();
    api.waitForWrite(
        [entry(() => new Promise(() => {}))],
        { diagId: "abc123" },
        new Promise(() => {}),
    );
    advance(15000);
    const all = events();
    assert.equal(all.find((e) => e.evt === "upload.perm.wait").q, "unknown");
    assert.equal(all.find((e) => e.evt === "run.stall").stage, "perm");
    assert.equal(
        all.some((e) => e.evt === "upload.perm.result"),
        false,
    );
});

test("skip reports once and discards late response", async () => {
    const { api, events } = await load();
    let skip, answer;
    const request = new Promise((resolve) => {
        answer = resolve;
    });
    const skipped = new Promise((resolve) => {
        skip = resolve;
    });
    const waiting = api.waitForWrite(
        [entry(() => request)],
        { diagId: "abc123" },
        skipped,
    );
    skip();
    assert.equal(await waiting, false);
    answer("granted");
    await request;
    await new Promise(setImmediate);
    assert.deepEqual(
        events()
            .filter((e) => e.evt === "upload.perm.result")
            .map((e) => e.result),
        ["skipped"],
    );
});

test("permission rejection reports constrained error name", async () => {
    const { api, events } = await load();
    const allowed = await api.waitForWrite(
        [entry(() => Promise.reject(new TypeError("secret-token-example")))],
        { diagId: "abc123" },
        new Promise(() => {}),
    );
    assert.equal(allowed, false);
    const result = events().find((e) => e.evt === "upload.perm.result");
    assert.equal(result.result, "threw");
    assert.equal(result.errName, "TypeError");
    const other = await load();
    assert.equal(
        await other.api.waitForWrite(
            [
                entry(() => {
                    throw new TypeError("secret-token-example");
                }),
            ],
            { diagId: "abc123" },
            new Promise(() => {}),
        ),
        false,
    );
    const thrown = other.events().find((e) => e.evt === "upload.perm.result");
    assert.equal(thrown.result, "threw");
    assert.equal(thrown.errName, "TypeError");
});

test("throwing diagnostics preserve permission returns", async () => {
    const { api } = await load(true);
    assert.equal(
        await api.askToWrite([entry(async () => "granted")], {}),
        true,
    );
    assert.equal(
        await api.waitForWrite(
            [entry(async () => "denied")],
            {},
            new Promise(() => {}),
        ),
        false,
    );
    assert.equal(await api.writeFolderFor({}, {}), null);
});

test("events contain no private values and pass sanitizer unchanged", async () => {
    const { api, events } = await load();
    await api.askToWrite([entry(async () => "granted")], { diagId: "abc123" });
    for (const event of events()) {
        assert.equal(
            JSON.stringify(event).includes("secret-token-example"),
            false,
        );
        const sanitized = sanitizeDiag(event);
        assert.equal(sanitized.dropped, 0);
        assert.deepEqual(sanitized.event, event);
    }
});

test("remembered folder uses its existing permission query", async () => {
    const folder = {
        resolve: async () => ["secret-token-example.jpg"],
        queryPermission: async () => "prompt",
        requestPermission: async () => "granted",
    };
    const { api, events } = await load(false, [folder]);
    const allowed = await api.askToWrite(
        [entry(async () => "granted"), entry(async () => "granted")],
        { diagId: "abc123" },
    );
    assert.equal(allowed, true);
    const wait = events().find((e) => e.evt === "upload.perm.wait");
    assert.equal(wait.kind, "folder");
    assert.equal(wait.n, 2);
    assert.equal(wait.q, "prompt");
    assert.equal(
        events().find((e) => e.evt === "upload.perm.result").result,
        "granted",
    );
});

async function loadUpload({
    throwing = false,
    records = [],
    scopeChange = false,
    enqueue = true,
} = {}) {
    const actions = (
        await readFile(
            new URL("../../src/utils/driveActions.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const app = await readFile(
        new URL("../../src/pages/drive/DriveApp.jsx", import.meta.url),
        "utf8",
    );
    const functions = app.slice(
        app.indexOf("    function newRun()"),
        app.indexOf("    // ----- keyboard"),
    );
    const events = [];
    const scope = {};
    let scopeCalls = 0;
    const context = vm.createContext({
        diag: (evt, fields) => {
            if (throwing) throw new Error("injected");
            const input = JSON.parse(JSON.stringify({ evt, ...fields }));
            const result = sanitizeDiag(input);
            assert.equal(result.dropped, 0);
            assert.deepEqual(result.event, input);
            events.push(input);
        },
        diagRun: () => "abc123",
        diagStage() {},
        diagStageEnd() {},
        diagRunEnd() {},
        Date,
        Promise,
        Set,
        Map,
        Math,
        uploadScope: () => (scopeChange && ++scopeCalls > 1 ? {} : scope),
        UPLOAD_OWNER: scopeChange,
        SPLIT_RAW: true,
        uploadLimit: () => Infinity,
        buildTreeFromPaths: (entries) => ({ folders: [], files: entries }),
        getSnapshot: () => ({ records }),
        findFolder: () => null,
        enqueueUpload: () => (enqueue ? {} : null),
        readEntries: async () => [],
        liveTabs: async () => new Set(),
        isQueued: () => false,
        TAB: "tab",
        KEPT: {},
        Store: { dispatch() {} },
        uploadTarget: null,
        activeRun: { current: null },
        mounted: { current: true },
        setScanning() {},
        setResumeScan() {},
        setNotice() {},
        setDropping() {},
        dragDepth: { current: 0 },
        setDialog: ({ resolve }) =>
            resolve({ asMedia: false, removeOriginal: false }),
        isMedia: () => false,
        canKeepHandles: true,
        inTrash: false,
        useCallback: (fn) => fn,
        scanProgress: (progress, batch) => {
            const found = [];
            return {
                add(file) {
                    progress({ files: 1, bytes: file.size });
                },
                found(item) {
                    found.push(item);
                },
                done() {
                    batch(found);
                },
                cancel() {},
            };
        },
        entriesOf: async (handle, scan) => {
            const item = { file: handle.file, handle };
            scan.add(item.file);
            scan.found(item);
            return [item];
        },
    });
    const api = vm.runInContext(
        `${actions}\n${functions}\n;({newRun, finishRun, uploadEntries, dropHandlers, activeRun})`,
        context,
    );
    return { api, events };
}

test("normal drop emits ordered timeline", async () => {
    const { api, events } = await loadUpload();
    api.dropHandlers.onDrop({
        preventDefault() {},
        dataTransfer: {
            types: ["Files"],
            items: [
                {
                    kind: "file",
                    getAsFileSystemHandle: async () => ({
                        file: { name: "secret-token-example.jpg", size: 1 },
                    }),
                },
            ],
        },
    });
    await new Promise(setImmediate);
    const expected = [
        "upload.start",
        "upload.mode.open",
        "upload.scan.done",
        "upload.mode.answer",
        "upload.entries.start",
        "upload.entries.plan",
        "run.finish",
    ];
    const timeline = events
        .map((event) => event.evt)
        .filter((evt) => expected.includes(evt));
    console.log(`timeline: ${timeline.join(" -> ")}`);
    assert.deepEqual(timeline, expected);
    assert.equal(
        JSON.stringify(events).includes("secret-token-example"),
        false,
    );
});

test("empty, cancel, scope and enqueue failure report stops and one finish", async () => {
    for (const reason of ["empty", "cancel", "scope", "enqueueFailed"]) {
        const record = {
            type: "file",
            name: "secret-token-example.jpg",
            size: 1,
            file_id: 9,
            parent: null,
        };
        const { api, events } = await loadUpload({
            records: reason === "cancel" ? [record] : [],
            scopeChange: reason === "scope",
            enqueue: reason !== "enqueueFailed",
        });
        const run = api.newRun();
        run.found = 1;
        const entries =
            reason === "empty"
                ? []
                : [{ file: { name: record.name, size: 1 } }];
        const counts = await api.uploadEntries(entries, null, {
            run,
            onConflict: async () => "cancel",
        });
        Object.assign(run.counts, counts);
        if (reason !== "empty")
            run.diagReason =
                reason === "enqueueFailed" ? "enqueueFailed" : reason;
        api.finishRun(run);
        api.finishRun(run);
        assert.equal(
            events.find((event) => event.evt === "upload.entries.stop")?.reason,
            reason,
        );
        assert.equal(
            events.filter((event) => event.evt === "run.finish").length,
            1,
        );
    }
});

test("notice kinds match schema and every notice has a kind", async () => {
    const app = await readFile(
        new URL("../../src/pages/drive/DriveApp.jsx", import.meta.url),
        "utf8",
    );
    const schema = await readFile(
        new URL("../diagSchema.js", import.meta.url),
        "utf8",
    );
    const kinds = [
        ...schema
            .match(/"ui\.notice":\s*\{[\s\S]*?kind:\s*\[([\s\S]*?)\]/)[1]
            .matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    const used = [
        ...app.matchAll(
            /setNotice\(\{\s*(?:\.\.\.value,\s*)?kind:\s*"([^"]+)"/g,
        ),
    ].map((m) => m[1]);
    assert.equal(used.length, (app.match(/setNotice\(\{/g) || []).length);
    assert.ok(used.every((kind) => kinds.includes(kind)));
    assert.deepEqual([...new Set(used)].sort(), kinds.sort());
});

test("finish records one event and the notice severity for each return path", async () => {
    for (const [setup, severity] of [
        [{}, "none"],
        [{ found: 1 }, "warning"],
        [{ target: "folder", queued: 1 }, "none"],
        [{ target: "folder", queued: 1, permissionDenied: true }, "info"],
    ]) {
        const { api, events } = await loadUpload();
        const run = api.newRun();
        Object.assign(run, setup);
        run.counts.queued = setup.queued ?? 0;
        api.finishRun(run);
        api.finishRun(run);
        const finishes = events.filter((event) => event.evt === "run.finish");
        assert.equal(finishes.length, 1);
        assert.equal(finishes[0].notice, severity);
    }
});

test("throwing diagnostics preserve upload and finish returns", async () => {
    const { api } = await loadUpload({ throwing: true });
    const run = api.newRun();
    const result = await api.uploadEntries(
        [{ file: { name: "secret-token-example.jpg", size: 1 } }],
        null,
        { run },
    );
    assert.equal(result.queued, 1);
    assert.equal(api.finishRun(run), undefined);
});

async function loadQueue({
    failing = false,
    throwing = false,
    online = true,
} = {}) {
    const read = async (path) =>
        (await readFile(new URL(path, import.meta.url), "utf8"))
            .replace(/^import [\s\S]*?;\r?\n/gm, "")
            .replace(/\bexport default /g, "")
            .replace(/\bexport /g, "");
    const events = [];
    const diag = (evt, fields) => {
        if (throwing) throw new Error("injected");
        const event = JSON.parse(JSON.stringify({ evt, ...fields }));
        const result = sanitizeDiag(event);
        assert.equal(result.dropped, 0);
        assert.deepEqual(result.event, event);
        events.push(event);
    };
    const shared = {
        diag,
        diagRun: () => "abcd12",
        diagStage() {},
        diagStageEnd() {},
        swallow: (_site, fallback) => () => fallback,
        window: {},
        navigator: {},
        setTimeout: () => 0,
        setInterval: () => 0,
        clearInterval() {},
        clearTimeout() {},
    };
    const pickerContext = vm.createContext({ ...shared });
    pickerContext.setTimeout = (fn) => {
        fn();
        return 0;
    };
    const pickers = vm.runInContext(
        `${await read(
            "../../src/utils/pickers.js",
        )}\n;({ removePicked, KEPT })`,
        pickerContext,
    );
    let finish;
    const completed = new Promise((resolve) => {
        finish = resolve;
    });
    const record = {
        id: "private-record-id",
        name: "secret-token-example.jpg",
        size: 1,
        parent: null,
    };
    const scope = {};
    let connected = online;
    const client = {};
    const context = vm.createContext({
        ...shared,
        ...pickers,
        UPLOAD_OWNER: true,
        FILE_ENCRYPTION: false,
        uploadScope: () => scope,
        helpers: {},
        isOnline: () => connected,
        onClientChange() {},
        getClient: () => client,
        createFile: () => record,
        getRecord: () => record,
        fileOps: { getByID: async () => record, setFileId: async () => {} },
        flush: async () => {},
        trash() {},
        Store: {
            dispatch(action) {
                if (action?.type === "completed" || action?.type === "error")
                    finish(action);
            },
        },
        queuedProgress() {},
        batchProgress() {},
        completedProgress: () => ({ type: "completed" }),
        errorProgress: () => ({ type: "error" }),
        retryingProgress() {},
        keptProgress() {},
        logEntry() {},
        patchEntry() {},
        saveHandle() {},
        dropEntry() {},
        settleWrites: async () => {},
        uploadFile: async (_id, _file, options) => {
            if (failing) throw new TypeError("secret-token-example");
            await options.onSend("file");
            return { message: { id: 44 }, changes: {} };
        },
        isFinal: () => true,
        fromUpload() {},
        queueMicrotask,
    });
    const api = vm.runInContext(
        `${await read(
            "../../src/utils/uploadQueue.js",
        )}\n;({ enqueueUpload, pump })`,
        context,
    );
    const file = { name: record.name, size: 1, lastModified: 1 };
    const root = {
        kind: "file",
        queryPermission: async () => "granted",
        getFile: async () => file,
        remove: async () => {},
    };
    return {
        api,
        pickers,
        events,
        completed,
        file,
        root,
        setOnline: (value) => {
            connected = value;
        },
    };
}

test("file queue timeline completes and removes original", async () => {
    const { api, events, completed, file, root } = await loadQueue();
    api.enqueueUpload({
        file,
        handle: { root },
        removeOriginal: true,
        run: { diagId: "abc123" },
    });
    await completed;
    const expected = [
        "upload.enqueue",
        "queue.pump",
        "file.start",
        "file.done",
        "remove.original",
    ];
    const timeline = events
        .map((event) => event.evt)
        .filter(
            (event, i, all) =>
                expected.includes(event) &&
                (event !== "queue.pump" || all.indexOf(event) === i),
        );
    console.log(`file timeline: ${timeline.join(" -> ")}`);
    assert.deepEqual(timeline, expected);
    assert.equal(
        JSON.stringify(events).includes("secret-token-example"),
        false,
    );
    assert.equal(JSON.stringify(events).includes("private-record-id"), false);
});

test("terminal upload failure reports stage without success", async () => {
    const { api, events, completed, file } = await loadQueue({ failing: true });
    api.enqueueUpload({ file });
    await completed;
    assert.ok(events.find((event) => event.evt === "file.fail")?.stage);
    assert.equal(
        events.some((event) => event.evt === "file.done"),
        false,
    );
});

test("original removal reports permission, changed, locked and kept outcomes", async () => {
    const { pickers, events, file, root } = await loadQueue();
    const job = { diagFile: "abcd", run: { diagId: "abc123" } };
    const handle = { root };
    root.queryPermission = async () => "denied";
    assert.equal(
        await pickers.removePicked(handle, file, job),
        pickers.KEPT.permission,
    );
    root.queryPermission = async () => "granted";
    root.getFile = async () => ({ size: 2, lastModified: 1 });
    assert.equal(
        await pickers.removePicked(handle, file, job),
        pickers.KEPT.changed,
    );
    root.getFile = async () => file;
    root.remove = async () => {
        const error = new Error();
        error.name = "NoModificationAllowedError";
        throw error;
    };
    assert.equal(
        await pickers.removePicked(handle, file, job),
        pickers.KEPT.locked,
    );
    root.remove = async () => {
        throw new Error("secret-token-example");
    };
    await assert.rejects(pickers.removePicked(handle, file, job));
    assert.deepEqual(
        events
            .filter((event) => event.evt === "remove.original")
            .map((event) => event.result),
        ["permission", "changed", "locked", "kept"],
    );
    assert.equal(
        JSON.stringify(events).includes("secret-token-example"),
        false,
    );
});

test("queue only reports pump state changes and diagnostic throws are harmless", async () => {
    const queue = await loadQueue({ online: false });
    queue.api.enqueueUpload({ file: queue.file });
    queue.api.pump();
    queue.api.pump();
    assert.deepEqual(
        queue.events
            .filter((event) => event.evt === "queue.pump")
            .map((event) => event.state),
        ["offline"],
    );
    queue.setOnline(true);
    queue.api.pump();
    await queue.completed;
    const broken = await loadQueue({ throwing: true });
    assert.ok(
        broken.api.enqueueUpload({
            file: broken.file,
            handle: { root: broken.root },
            removeOriginal: true,
        }),
    );
    await broken.completed;
});

test("tree saves report success and version conflict retries", async () => {
    const source = (
        (await readFile(
            new URL("../../src/services/treeStore.js", import.meta.url),
            "utf8",
        )) +
        "\n" +
        (await readFile(
            new URL("../../src/services/drive.js", import.meta.url),
            "utf8",
        ))
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    for (const throwing of [false, true]) {
        const events = [];
        let attempts = 0;
        class ApiError extends Error {
            constructor() {
                super();
                this.status = 409;
                this.code = "version_conflict";
            }
        }
        const context = vm.createContext({
            diag: (evt, fields) => {
                if (throwing) throw new Error("injected");
                const event = { evt, ...fields };
                assert.equal(sanitizeDiag(event).dropped, 0);
                events.push(event);
            },
            ApiError,
            uuid4: () => "id",
            setTimeout: () => 0,
            clearTimeout() {},
            api: {
                getTree: async () => ({ version: 0 }),
                putTreeShards: async () => {
                    if (++attempts === 1) throw new ApiError();
                    return { version: 1 };
                },
            },
            encryptJson: async (_key, value) => ({ ...value, ct: "x" }),
        });
        const drive = vm.runInContext(
            `${source}\n;({openDrive, createFile, flush})`,
            context,
        );
        await drive.openDrive({});
        drive.createFile({ name: "secret-token-example.jpg", size: 1 });
        assert.equal(await drive.flush(), undefined);
        if (!throwing) {
            assert.equal(events[0].evt, "tree.save");
            assert.equal(events[0].ok, true);
            assert.equal(events[0].retries409, 1);
        }
    }
});

test("part retry callback runs only for an actual retry", async () => {
    const source = (
        await readFile(
            new URL("../../src/utils/transfer.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    class RPCError extends Error {}
    const context = vm.createContext({
        Api: { upload: { SaveFilePart: class {} }, InputFile: class {} },
        errors: { RPCError, FloodWaitError: class extends RPCError {} },
        helpers: { generateRandomLong: () => 1, sleep: async () => {} },
        Buffer,
        performance,
    });
    const { uploadParts } = vm.runInContext(
        `${source}\n;({uploadParts})`,
        context,
    );
    let attempts = 0,
        retries = 0;
    const client = {
        session: { dcId: 1 },
        getSender: async () => ({ isConnected: () => true }),
        invoke: async () => {
            if (++attempts === 1) throw new Error("transient");
        },
    };
    await uploadParts(
        client,
        {
            size: 1,
            name: "x",
            slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1) }),
        },
        {
            onRetry: () => {
                retries++;
            },
        },
    );
    assert.equal(attempts, 2);
    assert.equal(retries, 1);
});

test("a stored folder whose resolve never settles is given up after 2 s, not waited on forever", async () => {
    const folder = {
        resolve: () => new Promise(() => {}),
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
    };
    const { api, advance, events } = await load(false, [folder]);
    let settled = false;
    const done = api
        .askToWrite(
            [entry(async () => "granted"), entry(async () => "granted")],
            { diagId: "abc123" },
        )
        .then((value) => {
            settled = true;
            return value;
        });
    const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
    await wait();
    const names = () =>
        events()
            .filter((e) => e.evt === "upload.step")
            .map((e) => `${e.step}:${e.phase}`);
    assert.deepEqual(names(), [
        "loadFolders:start",
        "loadFolders:end",
        "resolveStored:start",
    ]);
    assert.equal(settled, false);
    advance(1999);
    await wait();
    assert.equal(settled, false);
    advance(1);
    await wait();
    assert.equal(settled, true);
    await done;
    assert.ok(names().includes("resolveStored:end"));
    const end = events().find(
        (e) => e.step === "resolveStored" && e.phase === "end",
    );
    assert.ok(end.ms >= 2000);
});

test("each remembered-folder step reports start then end, and a rejection reports fail", async () => {
    const folder = {
        resolve: async () => ["a.jpg"],
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
    };
    const { api, events } = await load(false, [folder]);
    const allowed = await api.askToWrite(
        [entry(async () => "granted"), entry(async () => "granted")],
        { diagId: "abc123" },
    );
    assert.equal(allowed, true);
    const steps = events()
        .filter((e) => e.evt === "upload.step")
        .map((e) => `${e.step}:${e.phase}`);
    assert.deepEqual(steps, [
        "loadFolders:start",
        "loadFolders:end",
        "resolveStored:start",
        "resolveStored:end",
        "queryStored:start",
        "queryStored:end",
        "resolveEach:start",
        "resolveEach:end",
    ]);
    console.log("step timeline:", steps.join(" > "));
    for (const event of events()) {
        assert.deepEqual(sanitizeDiag(event).event, event);
        assert.ok(!JSON.stringify(event).includes("secret-token"));
    }
    const failing = {
        resolve: async () => ["a.jpg"],
        queryPermission: async () => {
            throw new TypeError("secret-token-example.jpg");
        },
        requestPermission: async () => "granted",
    };
    const second = await load(false, [failing]);
    await second.api
        .askToWrite(
            [entry(async () => "granted"), entry(async () => "granted")],
            {
                diagId: "abc123",
            },
        )
        .catch(() => {});
    const fail = second.events().find((e) => e.phase === "fail");
    assert.equal(fail.step, "queryStored");
    assert.equal(fail.errName, "TypeError");
    assert.ok(!JSON.stringify(second.events()).includes("secret-token"));
});

test("throwing diagnostics leave the remembered-folder path unchanged", async () => {
    const folder = {
        resolve: async () => ["a.jpg"],
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
    };
    const { api } = await load(true, [folder]);
    const allowed = await api.askToWrite(
        [entry(async () => "granted"), entry(async () => "granted")],
        { diagId: "abc123" },
    );
    assert.equal(allowed, true);
});

test("a picked folder is compared with remembered ones, and one that never answers is dropped", async () => {
    const hung = {
        resolve: async () => null,
        queryPermission: async () => "granted",
        isSameEntry: () => new Promise(() => {}),
    };
    const other = {
        resolve: async () => null,
        queryPermission: async () => "granted",
        isSameEntry: async () => false,
    };
    const picked = {
        requestPermission: async () => "granted",
        queryPermission: async () => "granted",
    };
    const { api, advance, events } = await load(false, [hung, other], {
        showDirectoryPicker: async () => picked,
    });
    const done = api.writeFolderFor(
        { name: "secret-token-example.jpg" },
        { run: { diagId: "abc123" }, n: 2 },
    );
    const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
    await wait();
    advance(1000);
    await wait();
    const folder = await done;
    assert.equal(folder, picked);
    const steps = events()
        .filter((e) => e.evt === "upload.step")
        .map((e) => `${e.step}:${e.phase}`);
    assert.ok(steps.includes("picker:end"));
    assert.ok(steps.includes("sameEntry:end"));
    assert.ok(steps.includes("saveFolders:end"));
    assert.ok(!JSON.stringify(events()).includes("secret-token"));
});

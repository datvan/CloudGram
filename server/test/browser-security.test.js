// Module dependencies are replaced only at browser/Telegram/storage boundaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function load(path, globals, exports) {
    const source = (await readFile(new URL(path, import.meta.url), "utf8"))
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport default /g, "")
        .replace(/\bexport /g, "");
    const context = vm.createContext({
        console,
        URL,
        Response,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        queueMicrotask,
        ...globals,
    });
    return vm.runInContext(`${source}\n;({${exports.join(",")}})`, context);
}

for (const state of [
    "live",
    "trashed",
    "parent-trashed",
    "deleted",
    "replaced",
    "switched",
    "switch-during-save",
]) {
    test(`original retry rechecks persisted tree: ${state}`, async () => {
        let unavailable = true;
        let savedMessage = null;
        let nextRecord = 0;
        let afterSave = () => {};
        const drive = await load(
            "../../src/services/drive.js",
            {
                uuid4: () => (nextRecord++ === 0 ? "upload" : "folder"),
                api: {
                    getTree: async () => ({ version: 0 }),
                    putTree: async (blob) => {
                        if (unavailable) throw new Error("offline");
                        savedMessage = blob.records.find(
                            (record) => record.id === "upload",
                        )?.file_id;
                        afterSave();
                        return { version: 1 };
                    },
                },
                encryptJson: async (_, value) => value,
                setTimeout: () => 0,
            },
            [
                "openDrive",
                "getRecord",
                "createFile",
                "createFolder",
                "update",
                "trash",
                "removeRecords",
                "fileOps",
                "flush",
            ],
        );
        await drive.openDrive({});
        let scope = {};
        let removed = 0;
        let dropped = false;
        let completed;
        const finished = new Promise((resolve) => {
            completed = resolve;
        });
        const actions = [];
        const queue = await load(
            "../../src/utils/uploadQueue.js",
            {
                ...drive,
                UPLOAD_OWNER: true,
                uploadScope: () => scope,
                onClientChange() {},
                isOnline: () => true,
                getClient: () => ({}),
                helpers: {},
                Store: {
                    dispatch(action) {
                        actions.push(action);
                        if (action?.type === "COMPLETED") completed(action);
                    },
                },
                batchProgress() {},
                queuedProgress() {},
                completedProgress: (id, kept) => ({
                    type: "COMPLETED",
                    id,
                    kept,
                }),
                keptProgress: (id, name, kept) => ({
                    type: "KEPT",
                    id,
                    name,
                    kept,
                }),
                logEntry() {},
                patchEntry() {},
                saveHandle() {},
                dropEntry() {
                    dropped = true;
                },
                settleWrites: async () => {},
                uploadFile: async () => ({ message: { id: 42 }, changes: {} }),
                fromUpload() {},
                KEPT: {
                    notStored: "not stored",
                    permission: "permission",
                    locked: "locked",
                    trashed: "trashed",
                    gone: "gone",
                },
                removePicked: async () => {
                    assert.equal(
                        savedMessage,
                        42,
                        "server must acknowledge message before deletion",
                    );
                    removed++;
                    return null;
                },
            },
            ["enqueueUpload", "canRetryRemove", "retryRemoveOriginals"],
        );
        const record = queue.enqueueUpload({
            file: { name: "original", size: 1 },
            removeOriginal: true,
            handle: { root: { requestPermission: async () => "granted" } },
        });
        assert.equal((await finished).kept, "not stored");
        assert.equal(removed, 0);
        assert.equal(queue.canRetryRemove(record.id), true);
        await queue.retryRemoveOriginals([record.id]);
        assert.equal(removed, 0, "a failed save must keep the original");
        unavailable = false;
        if (state === "trashed") drive.trash([record.id]);
        if (state === "parent-trashed") {
            const folder = drive.createFolder("folder");
            drive.update(record.id, { parent: folder.id });
            drive.trash([folder.id]);
        }
        if (state === "deleted") await drive.removeRecords([record.id]);
        if (state === "replaced") drive.update(record.id, { file_id: 99 });
        if (state === "switched") scope = {};
        if (state === "switch-during-save")
            afterSave = () => {
                scope = {};
            };
        await queue.retryRemoveOriginals([record.id]);
        if (state !== "live") {
            assert.equal(removed, 0, "unsafe originals must be retained");
            assert.equal(queue.canRetryRemove(record.id), false);
            if (state !== "switched" && state !== "switch-during-save") {
                assert.equal(
                    actions.at(-1).kept,
                    state.includes("trashed") ? "trashed" : "gone",
                );
            }
            return;
        }
        assert.equal(removed, 1);
        assert.equal(dropped, true);
        assert.equal(actions.at(-1).kept, null);
        assert.equal(queue.canRetryRemove(record.id), false);
    });
}

for (const enabled of [true, false]) {
    test(`deferred log writes stay with original owner: flag=${enabled}`, async () => {
        const rows = new Map();
        const handles = new Map();
        const store = (data) => ({
            put: (value, id) => data.set(id, value),
            delete: (id) => data.delete(id),
        });
        const log = await load(
            "../../src/services/uploadLog.js",
            {
                LOG_OWNER: enabled,
                uuid4: () => "tab",
                navigator: {},
                encryptJson: async (key, entry) => ({ key, entry }),
                indexedDB: {
                    open() {
                        const req = {};
                        queueMicrotask(() => {
                            req.result = {
                                close() {},
                                transaction() {
                                    const tx = {
                                        objectStore: (name) =>
                                            store(
                                                name === "entries"
                                                    ? rows
                                                    : handles,
                                            ),
                                    };
                                    setImmediate(() => tx.oncomplete());
                                    return tx;
                                },
                            };
                            req.onsuccess();
                        });
                        return req;
                    },
                },
                setTimeout: () => 0,
            },
            [
                "openUploadLog",
                "closeUploadLog",
                "logEntry",
                "patchEntry",
                "settleWrites",
            ],
        );
        log.openUploadLog("alice", "key-A");
        log.logEntry("upload", { path: "private-folder/file" });
        log.patchEntry("upload", { messageId: 123 });
        const closed = log.closeUploadLog();
        log.openUploadLog("bob", "key-B");
        await closed;
        await log.settleWrites();
        assert.equal(rows.get("upload").username, enabled ? "alice" : "bob");
        assert.equal(rows.get("upload").blob.key, enabled ? "key-A" : "key-B");
        assert.equal(rows.get("upload").blob.entry.messageId, 123);
    });
}

test("in-flight upload cannot acquire another account after preparing media", async () => {
    let prepared;
    const preparation = new Promise((resolve) => {
        prepared = resolve;
    });
    let current = true;
    let transferred = false;
    const uploader = await load(
        "../../src/utils/uploadFile.js",
        {
            Api: {},
            errors: {},
            turns: () => ({ take: async () => {}, give() {} }),
            typeOf: () => "application/octet-stream",
            makeThumb: () => preparation,
            getClient: () => {
                throw new Error("Must use bound client");
            },
            uploadParts: async () => {
                transferred = true;
            },
        },
        ["uploadFile"],
    );
    const pending = uploader.uploadFile(
        "id",
        { size: 1 },
        {
            client: {},
            assertCurrent: () => {
                if (!current) throw new Error("Upload account changed");
            },
        },
    );
    current = false;
    prepared(null);
    await assert.rejects(pending, { message: "Upload account changed" });
    assert.equal(transferred, false);
});

for (const enabled of [true, false]) {
    test(`stream blocks navigation and active MIME: flag=${enabled}`, async () => {
        const listeners = {};
        let asked = 0;
        let mime = "text/html";
        const client = {
            postMessage(_, [port]) {
                asked++;
                port.onmessage({
                    data: {
                        bytes: new Uint8Array([1]).buffer,
                        start: 0,
                        size: 1,
                        type: mime,
                    },
                });
            },
        };
        await load(
            "../../public/sw.js",
            {
                self: {
                    location: {
                        href: `https://cg.test/sw.js?streamGuard=${
                            enabled ? 1 : 0
                        }`,
                        origin: "https://cg.test",
                    },
                    addEventListener: (type, fn) => {
                        listeners[type] = fn;
                    },
                    clients: {
                        get: async () => client,
                        matchAll: async () => [client],
                    },
                },
                MessageChannel: class {
                    constructor() {
                        this.port1 = {};
                        this.port2 = this.port1;
                    }
                },
            },
            [],
        );
        async function request(destination, clientId = "tab") {
            let response;
            listeners.fetch({
                clientId,
                request: {
                    url: "https://cg.test/stream/1/x.html",
                    method: "GET",
                    destination,
                    headers: new Headers(),
                },
                respondWith: (value) => {
                    response = value;
                },
            });
            return await response;
        }
        assert.equal((await request("document")).status, enabled ? 403 : 206);
        if (enabled) assert.equal(asked, 0);
        const media = await request("video");
        assert.equal(media.status, 206);
        assert.equal(
            media.headers.get("Content-Type"),
            enabled ? "application/octet-stream" : "text/html",
        );
        assert.equal(
            media.headers.get("X-Content-Type-Options"),
            enabled ? "nosniff" : null,
        );
        mime = "video/mp4";
        const video = await request("video");
        assert.equal(video.status, 206);
        assert.equal(video.headers.get("Content-Type"), "video/mp4");
        assert.equal(video.headers.get("Content-Range"), "bytes 0-0/1");
        assert.equal((await request("video", "")).status, enabled ? 403 : 206);
    });

    for (const changed of [true, false]) {
        test(`queued upload account transition: flag=${enabled}, changed=${changed}`, async () => {
            let scope = {};
            let online = false;
            let listener;
            const sent = [];
            const records = new Map();
            let next = 0;
            const queue = await load(
                "../../src/utils/uploadQueue.js",
                {
                    UPLOAD_OWNER: enabled,
                    helpers: {},
                    uploadScope: () => scope,
                    createFile: (r) => {
                        const row = { ...r, id: String(++next) };
                        records.set(row.id, row);
                        return row;
                    },
                    getRecord: (id) => records.get(id),
                    isOnline: () => online,
                    getClient: () => ({ account: "B" }),
                    onClientChange: (fn) => {
                        listener = fn;
                    },
                    Store: { dispatch() {} },
                    batchProgress() {},
                    queuedProgress() {},
                    completedProgress() {},
                    retryingProgress() {},
                    errorProgress() {},
                    logEntry() {},
                    saveHandle() {},
                    patchEntry() {},
                    dropEntry() {},
                    settleWrites: async () => {},
                    uploadFile: async (_, file) => {
                        sent.push(file.name);
                        throw { maybeSent: true };
                    },
                    isFinal: () => true,
                    setTimeout: () => 0,
                },
                ["enqueueUpload", "hasJob"],
            );
            const record = queue.enqueueUpload({
                file: { name: "private-A", size: 1 },
            });
            if (changed) scope = {};
            online = true;
            listener({});
            await new Promise(setImmediate);
            assert.equal(sent.length, enabled && changed ? 0 : 1);
            if (enabled && changed)
                assert.equal(queue.hasJob(record.id), false);
        });
    }
}

test("in-flight upload rechecks owner immediately before send", async () => {
    let resume;
    const sending = new Promise((resolve) => {
        resume = resolve;
    });
    let reached;
    const ready = new Promise((resolve) => {
        reached = resolve;
    });
    let current = true;
    let sent = false;
    const uploader = await load(
        "../../src/utils/uploadFile.js",
        {
            Api: {},
            errors: { RPCError: class extends Error {} },
            turns: () => ({ take: async () => {}, give() {} }),
            typeOf: () => "application/octet-stream",
            makeThumb: async () => null,
            performance,
            uploadParts: async () => ({}),
        },
        ["uploadFile"],
    );
    const pending = uploader.uploadFile(
        "id",
        { size: 1 },
        {
            client: {
                sendFile: async () => {
                    sent = true;
                },
            },
            assertCurrent: () => {
                if (!current) throw new Error("Upload account changed");
            },
            onSend: () => {
                reached();
                return sending;
            },
        },
    );
    await ready;
    current = false;
    resume();
    await assert.rejects(pending, { message: "Upload account changed" });
    assert.equal(sent, false);
});

test("upload dialog cannot enqueue into a later account", async () => {
    let scope = {};
    let answer;
    let queued = 0;
    const choice = new Promise((resolve) => {
        answer = resolve;
    });
    const file = { name: "private-A", size: 1 };
    const actions = await load(
        "../../src/utils/driveActions.js",
        {
            UPLOAD_OWNER: true,
            uploadScope: () => scope,
            uploadLimit: () => Infinity,
            buildTreeFromPaths: () => ({ folders: [], files: [{ file }] }),
            getSnapshot: () => ({
                records: [
                    {
                        id: "old",
                        type: "file",
                        name: file.name,
                        size: 1,
                        file_id: 1,
                    },
                ],
            }),
            enqueueUpload: () => {
                queued++;
            },
        },
        ["uploadEntries"],
    );
    const pending = actions.uploadEntries([], null, {
        onConflict: () => choice,
    });
    scope = {};
    answer("replace");
    await pending;
    assert.equal(queued, 0);
});

test("a file over Telegram's limit is reported, not queued", async () => {
    const big = { name: "big.mkv", size: 11 };
    const small = { name: "small.txt", size: 5 };
    const queued = [];
    const reported = [];
    const actions = await load(
        "../../src/utils/driveActions.js",
        {
            UPLOAD_OWNER: false,
            KEPT: {},
            uploadScope: () => ({}),
            uploadLimit: () => 10,
            buildTreeFromPaths: () => ({
                folders: [],
                files: [{ file: big }, { file: small }],
            }),
            getSnapshot: () => ({ records: [] }),
            enqueueUpload: ({ file }) => queued.push(file.name),
        },
        ["uploadEntries"],
    );
    const counts = await actions.uploadEntries([], null, {
        onTooBig: (files, limit) => reported.push({ files, limit }),
    });
    assert.deepEqual(queued, ["small.txt"]);
    assert.equal(counts.queued, 1);
    assert.equal(counts.skipped, 1);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].limit, 10);
    assert.deepEqual(
        reported[0].files.map((f) => [f.name, f.size]),
        [["big.mkv", 11]],
    );
});

test("Dropbox import stops when account changes during resolution", async () => {
    let scope = {};
    let resolveLink;
    let fetched = false;
    const resolution = new Promise((resolve) => {
        resolveLink = resolve;
    });
    const imports = await load(
        "../../src/services/dropboxImport.js",
        {
            UPLOAD_OWNER: true,
            uploadScope: () => scope,
            uploadLimit: () => Infinity,
            formatSize: String,
            api: { resolveDropbox: () => resolution },
            onClientChange() {},
            uuid4: () => "import",
            logEntry() {},
            dropEntry() {
                throw new Error("Must retain original account's log");
            },
            AbortController,
            fetch: () => {
                fetched = true;
                throw new Error("Must not fetch");
            },
            useSyncExternalStore: (_, snapshot) => snapshot(),
        },
        ["startImport", "useImports"],
    );
    imports.startImport(["https://www.dropbox.com/s/x/file"], null);
    scope = {};
    resolveLink({ url: "https://example.invalid/file" });
    await new Promise(setImmediate);
    assert.equal(fetched, false);
    assert.equal(imports.useImports()[0].status, "cancelled");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { File } from "node:buffer";
import {
    encryptPreview,
    decryptPreview,
} from "../../src/services/previewCrypto.js";

async function harness({
    missed = [],
    black = false,
    dark = false,
    duration = 81,
    errors = [],
    width = 320,
    height = 180,
    metadataTimeouts = 0,
    flush = async () => {},
    upload = async (_, file) => file,
    online = () => true,
    validate = async () => {},
    image = false,
    onSeek = () => {},
    fetchFile = async () => new Blob(),
    shrink = async () => new Blob(["jpeg"]),
} = {}) {
    const records = [
        { id: "a", file_id: 1, thumbnail: 50 },
        { id: "b", file_id: 1, thumbnail: 50 },
    ];
    let draws = 0;
    let sent = 0;
    let scope = {};
    let mode = "private";
    let activeClient;
    let savedClient;
    let clientChanged;
    const deleted = [];
    const updateOptions = [];
    const evicted = [];
    const captured = [];
    const delays = [];
    const uploads = [];
    const encrypted = [];
    const client = {
        getMessages: async () => [{ media: { document: { size: 100 } } }],
        downloadMedia: async () => new Uint8Array([1]),
        sendFile: async (_, options) => {
            uploads.push(options);
            return { id: ++sent + 100 };
        },
        deleteMessages: async (_, ids) => deleted.push(...ids),
    };
    activeClient = client;
    savedClient = client;
    class Video extends EventTarget {
        duration = duration;
        videoWidth = width;
        videoHeight = height;
        index = 0;
        set src(value) {
            this.url = value;
            const error = errors[draws++];
            if (draws <= metadataTimeouts) return;
            queueMicrotask(() => {
                if (error) {
                    this.error = error;
                    this.dispatchEvent(new Event("error"));
                } else this.dispatchEvent(new Event("loadedmetadata"));
            });
        }
        set currentTime(value) {
            this.index = Math.floor(value);
            onSeek();
            if (
                !(typeof missed === "function"
                    ? missed(draws, this.index)
                    : missed.includes(this.index))
            )
                this.dispatchEvent(new Event("seeked"));
        }
        removeAttribute() {}
        load() {}
    }
    let current;
    const context = {
        drawImage(video) {
            current = video.index;
        },
        getImageData() {
            const data = new Uint8ClampedArray(8 * 8 * 4);
            for (let i = 0; i < data.length; i += 4) {
                const value =
                    black || (dark && current < 35)
                        ? 0
                        : 20 + current * 2 + (i % 32);
                data[i] = value;
                data[i + 1] = value;
                data[i + 2] = value;
                data[i + 3] = 255;
            }
            return { data };
        },
    };
    const source = (
        await readFile(
            new URL("../../src/services/thumbnailOverride.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const mod = vm.runInNewContext(
        `${source}\n;({drawVideo,regenerateThumbnail,sessionState})`,
        {
            canStream: () => true,
            streamUrl: (_, options) => {
                assert.equal(options.quiet, true);
                return "stream?quiet";
            },
            holdThumbnails: () => () => {},
            encodeScaled: async (video) => {
                captured.push(video.index);
                return new Blob(["jpeg"]);
            },
            shrink,
            fetchFile,
            typeOf: () => "image/jpeg",
            evictThumbnails: (rs) => evicted.push(...rs.map((r) => r.id)),
            console: { log() {} },
            Event,
            AbortController,
            DOMException,
            Blob,
            structuredClone,
            encryptPreview: async (...args) => {
                const result = await encryptPreview(...args);
                encrypted.push(result);
                return result;
            },
            btoa,
            File,
            setTimeout(fn, ms) {
                delays.push(ms);
                return setTimeout(fn, ms === 30000 ? 1 : ms === 60000 ? 5 : 0);
            },
            clearTimeout,
            setInterval,
            clearInterval,
            document: {
                createElement: (tag) =>
                    tag === "video"
                        ? new Video()
                        : {
                              getContext: () => context,
                              toBlob: (fn) => fn(new Blob(["jpeg"])),
                          },
            },
            URL: { createObjectURL: () => "blob:sprite", revokeObjectURL() {} },
            getClient: () => activeClient,
            getTelegramMode: async (candidate) => {
                await validate();
                return candidate === savedClient ? mode : null;
            },
            isMigrating: () => false,
            isOnline: online,
            onClientChange(fn) {
                clientChanged = fn;
            },
            uploadScope: () => scope,
            getRecord: (id) => records.find((r) => r.id === id),
            getSnapshot: () => ({ records }),
            update(id, patch, options) {
                updateOptions.push(options);
                Object.assign(
                    records.find((r) => r.id === id),
                    patch,
                    {
                        updatedAt:
                            (records.find((r) => r.id === id).updatedAt ?? 0) +
                            1,
                    },
                );
            },
            flush,
            uploadParts: upload,
            previewKind: () => (image ? "image" : "video"),
        },
    );
    return {
        ...mod,
        records,
        deleted,
        updateOptions,
        evicted,
        captured,
        delays,
        uploads,
        encrypted,
        client,
        clientChanged: (...args) => clientChanged(...args),
        switchAccount() {
            scope = {};
        },
        setMode(value) {
            mode = value;
        },
        setClient(value) {
            activeClient = value;
        },
        replaceSavedClient() {
            savedClient = {};
        },
        stats: () => ({ draws, sent }),
    };
}

const make = (h, options = {}) =>
    h.regenerateThumbnail(h.records[0], { retryDelays: [0, 0], ...options });

test("session validation retries outage and rejects 401 or changed session on retry", async () => {
    let calls = 0;
    const h = await harness({
        validate: async () => {
            if (++calls === 1) throw new Error("offline");
        },
    });
    await make(h);
    assert.ok(calls >= 3);
    let denied = 0;
    const d = await harness({
        validate: async () => {
            denied++;
            throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
    });
    await assert.rejects(make(d), /unauthorized/);
    assert.equal(denied, 1);
    assert.equal(d.stats().sent, 0);
    let attempts = 0;
    const changed = await harness({
        validate: async () => {
            if (++attempts === 2) changed.replaceSavedClient();
        },
    });
    await assert.rejects(make(changed), /session/);
    assert.equal(changed.stats().sent, 0);
});

test("collision across interrupted migration stays isolated and resumes on shared client", async () => {
    const h = await harness();
    h.records.push({ id: "shared", file_id: 1, tg: "shared" });
    await assert.rejects(h.regenerateThumbnail(h.records[2]), /session/);
    assert.equal(h.stats().draws, 0);
    await make(h);
    assert.deepEqual(h.records[0].thumbnailBlob, h.records[1].thumbnailBlob);
    assert.equal(h.records[2].thumbnailBlob, undefined);
    h.setMode("shared");
    await assert.rejects(make(h), /session/);
    await h.regenerateThumbnail(h.records[2]);
    assert.notEqual(
        h.records[2].thumbnailBlob.message,
        h.records[0].thumbnailBlob.message,
    );
    assert.deepEqual(h.deleted, []);
});

test("session change during thumbnail upload fails closed", async () => {
    let h;
    h = await harness({
        upload: async () => {
            h.setClient({});
            return {};
        },
    });
    await assert.rejects(make(h), /thay đổi/);
    assert.equal(h.stats().sent, 0);
    assert.equal(h.records[0].thumbnailBlob, undefined);
});

test("saved session mismatch rejects before drawing thumbnail", async () => {
    const h = await harness();
    h.replaceSavedClient();
    await assert.rejects(make(h), /session/);
    assert.equal(h.stats().draws, 0);
    assert.equal(h.stats().sent, 0);
});

test("stale thumbnail source cannot join existing work", async () => {
    const h = await harness();
    const stale = { ...h.records[0], tg: "shared" };
    const job = make(h);
    await assert.rejects(h.regenerateThumbnail(stale), /thay đổi/);
    await job;
});
test("blank first candidate skipped; seek listener attached before currentTime", async () => {
    const h = await harness({ dark: true, duration: 100 });
    await make(h);
    assert.deepEqual(h.captured, [50]);
    const next = await harness({ dark: true, duration: 1000 });
    await make(next);
    assert.equal(next.stats().sent, 1);
    assert.deepEqual(next.captured, [100]);
});
test("failure keeps old pointers, message and cache", async () => {
    const h = await harness({ black: true });
    await assert.rejects(make(h));
    assert.ok(h.records.every((r) => r.thumbnail === 50));
    assert.deepEqual(h.deleted, []);
    assert.deepEqual(h.evicted, []);
});
for (const referenced of [true, false])
    test(`success shares pointer; old referenced=${referenced}`, async () => {
        const h = await harness();
        if (referenced) h.records.push({ id: "c", file_id: 2, thumbnail: 50 });
        await make(h);
        assert.ok(h.updateOptions.length > 0);
        assert.ok(
            h.updateOptions.every(
                (option) => option?.preserveModifiedAt === true,
            ),
        );
        assert.ok(
            h.records
                .filter((r) => r.file_id === 1)
                .every(
                    (r) =>
                        r.thumbnail === 50 && r.thumbnailBlob.message === 101,
                ),
        );
        assert.deepEqual(h.deleted, []);
        assert.deepEqual(h.evicted, ["a", "b"]);
    });
test("dedup same-file concurrent clicks", async () => {
    const h = await harness();
    const first = make(h);
    assert.equal(first, h.regenerateThumbnail(h.records[1]));
    await first;
    assert.equal(h.stats().sent, 1);
});
test("abort during seek writes nothing", async () => {
    const controller = new AbortController();
    const h = await harness({
        missed: [1],
        onSeek: () => queueMicrotask(() => controller.abort()),
    });
    const job = make(h, { signal: controller.signal });
    await assert.rejects(job, { name: "AbortError" });
    assert.equal(h.stats().sent, 0);
    assert.ok(h.records.every((r) => r.thumbnail === 50));
});
test("save failure restores old pointers, keeps both messages and cache", async () => {
    const h = await harness({
        flush: async () => {
            throw new Error("save failed");
        },
    });
    await assert.rejects(make(h), /save failed/);
    assert.ok(h.records.every((r) => r.thumbnail === 50));
    assert.deepEqual(h.deleted, []);
    assert.deepEqual(h.evicted, []);
});
test("transient decode/stream failure retries; permanent failure stops", async () => {
    const h = await harness({
        errors: [new Error("network"), new Error("network")],
    });
    await make(h);
    assert.equal(h.stats().draws, 3);
    const bad = await harness({
        errors: [Object.assign(new Error("decode"), { code: 3 })],
    });
    await assert.rejects(make(bad), /decode/);
    assert.equal(bad.stats().draws, 1);
});
test("image original regenerated; over 100 MiB rejected immediately", async () => {
    const h = await harness({ image: true });
    await make(h);
    assert.equal(h.records[0].thumbnailBlob.message, 101);
    const big = await harness({ image: true });
    big.records[0].size = 100 * 1024 * 1024 + 1;
    await assert.rejects(make(big), /100 MiB/);
    assert.equal(big.stats().sent, 0);
});

test("encrypted image regeneration uses decrypted original", async () => {
    const plain = Uint8Array.of(4, 5, 6);
    let reads = 0;
    const h = await harness({
        image: true,
        fetchFile: async (id, fileId, options) => {
            assert.equal(id, "a");
            assert.equal(fileId, 1);
            assert.equal(options.quiet, true);
            reads++;
            return new Blob([plain]);
        },
        shrink: async (blob) => {
            assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), plain);
            return new Blob(["jpeg"]);
        },
    });
    h.records[0].enc = { size: 3 };
    h.client.downloadMedia = async () => {
        throw new Error("must not read ciphertext");
    };
    await make(h);
    assert.equal(reads, 1);
    assert.equal(h.records[0].thumbnailBlob.message, 101);
});

async function load(path, globals, exports) {
    const treeStore = path.endsWith("/drive.js")
        ? await readFile(
              new URL("../../src/services/treeStore.js", import.meta.url),
              "utf8",
          )
        : "";
    const source = (
        treeStore +
        "\n" +
        (await readFile(new URL(path, import.meta.url), "utf8"))
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport default /g, "")
        .replace(/\bexport /g, "");
    return vm.runInNewContext(`${source}\n;({${exports}})`, {
        console,
        setTimeout,
        clearTimeout,
        structuredClone,
        decryptPreview,
        DIAG_LOG: false,
        treeStats() {},
        ...globals,
    });
}
test("eviction clears cached null and revokes URL; stale result cannot replace new cache", async () => {
    const revoked = [];
    const h = await load(
        "../../src/utils/thumbnails.js",
        {
            onClientChange() {},
            URL: {
                revokeObjectURL: (u) => revoked.push(u),
                createObjectURL: () => "new",
            },
        },
        "cache,pending,evictThumbnails,settle,loadThumb",
    );
    const a = { id: "a", file_id: 1 };
    const b = { id: "b", file_id: 1 };
    h.cache.set("a:1", null);
    h.cache.set("b:1", "old");
    let resolved = false;
    const stale = {
        key: "a:1",
        resolve: () => {
            resolved = true;
        },
    };
    h.pending.set("a:1", stale);
    h.evictThumbnails([a, b]);
    assert.equal(h.cache.size, 0);
    assert.equal(resolved, true);
    assert.deepEqual(revoked, ["old"]);
    h.settle(stale, new Blob());
    assert.equal(h.cache.size, 0);
});
for (const linked of [true, false])
    test(`deleteForever cover last reference; linked=${linked}`, async () => {
        const records = [
            { id: "a", file_id: 1, thumbnail: 50 },
            { id: "b", file_id: 2, thumbnail: linked ? 50 : undefined },
        ];
        const deleted = [];
        const h = await load(
            "../../src/utils/driveActions.js",
            {
                getSnapshot: () => ({ records }),
                withConverted: (ids) => ids,
                collectSubtree: (_, id) => records.filter((r) => r.id === id),
                recordIdsOf: (rs) => rs.map((r) => r.id),
                messageIdsOf: (rs) => rs.map((r) => r.file_id),
                messagesOf: (r) => [r.file_id],
                cancelUploads() {},
                dropShares: async () => {},
                storyboardsOf: () => [],
                getClient: () => ({
                    deleteMessages: async (_, ids) => deleted.push(...ids),
                }),
                getTelegramMode: async () => "private",
                removeRecords: async () => {},
            },
            "deleteForever",
        );
        await h.deleteForever(["a"]);
        assert.deepEqual(deleted, linked ? [1] : [1, 50]);
    });
for (const scenario of ["last", "linked", "other-session", "save-fails"])
    test(`deleteForever encrypted cover: ${scenario}`, async () => {
        let records = [
            {
                id: "a",
                type: "file",
                file_id: 1,
                thumbnailBlob: { message: 50 },
            },
            ...(scenario === "linked" || scenario === "other-session"
                ? [
                      {
                          id: "b",
                          type: "file",
                          file_id: 2,
                          tg:
                              scenario === "other-session"
                                  ? "shared"
                                  : undefined,
                          thumbnailBlob: { message: 50 },
                      },
                  ]
                : []),
        ];
        const deleted = [];
        const h = await load(
            "../../src/utils/driveActions.js",
            {
                getSnapshot: () => ({ records }),
                withConverted: (ids) => ids,
                messagesOf: (r) => [r.file_id],
                recordIdsOf: (s) => [...s.folders, ...s.files].map((r) => r.id),
                messageIdsOf: (s) => s.files.map((r) => r.file_id),
                cancelUploads() {},
                dropShares: async () => {},
                storyboardsOf: () => [],
                getClient: () => ({
                    deleteMessages: async (_, ids) => deleted.push(...ids),
                }),
                getTelegramMode: async () => "private",
                removeRecords: async (ids) => {
                    if (scenario === "save-fails")
                        throw new Error("save failed");
                    records = records.filter((r) => !ids.includes(r.id));
                },
            },
            "deleteForever",
        );
        if (scenario === "save-fails")
            await assert.rejects(h.deleteForever(["a"]), /save failed/);
        else await h.deleteForever(["a"]);
        assert.deepEqual(
            deleted,
            scenario === "last"
                ? [1, 50]
                : scenario === "save-fails"
                ? []
                : [1],
        );
    });
test("thumbnail survives encrypted drive save/load round trip", async () => {
    let stored = { version: 0 };
    const h = await load(
        "../../src/services/drive.js",
        {
            uuid4: () => "a",
            setTimeout: () => 0,
            api: {
                getTree: async () => stored,
                putTreeShards: async ({ shards, count }) => {
                    stored = { shards, count, version: 1 };
                    return { version: 1 };
                },
            },
            encryptJson: async (_, tree) => ({ ...tree, ct: "x" }),
            decryptJson: async (_, tree) => tree,
        },
        "openDrive,closeDrive,createFile,update,flush,getRecord",
    );
    await h.openDrive({});
    h.createFile({ name: "image.jpg" });
    h.update("a", { file_id: 1, thumbData: "data:image/jpeg;base64,anBlZw==" });
    await h.flush();
    h.closeDrive();
    await h.openDrive({});
    assert.equal(h.getRecord("a").thumbData, "data:image/jpeg;base64,anBlZw==");
});

test("stale account scope rejected before draw or upload", async () => {
    const h = await harness();
    const scope = h.sessionState().scope;
    h.switchAccount();
    await assert.rejects(make(h, { scope }), { name: "AbortError" });
    assert.equal(h.stats().draws, 0);
    assert.equal(h.stats().sent, 0);
});
test("lease loss aborts active seek", async () => {
    let h;
    h = await harness({
        missed: [1],
        onSeek: () => queueMicrotask(() => h.clientChanged(null)),
    });
    await assert.rejects(make(h), { name: "AbortError" });
    assert.ok(h.records.every((r) => r.thumbnail === 50));
    assert.equal(h.stats().sent, 0);
});
test("account switch after original image lookup prevents download on next account", async () => {
    const h = await harness({ image: true });
    let downloaded = false;
    h.client.getMessages = async () => {
        h.switchAccount();
        return [{ media: {} }];
    };
    h.client.downloadMedia = async () => {
        downloaded = true;
        return [];
    };
    await assert.rejects(make(h), { name: "AbortError" });
    assert.equal(downloaded, false);
    assert.equal(h.stats().sent, 0);
});
test("FLOOD_WAIT/offline preserve retry budget", async () => {
    let polls = 0;
    const h = await harness({
        online: () => ++polls > 3,
        errors: [
            Object.assign(new Error("FLOOD_WAIT"), { seconds: 1 }),
            new Error("network"),
            new Error("network"),
        ],
    });
    await make(h);
    assert.equal(h.stats().draws, 4);
    assert.ok(h.delays.includes(1000));
});
test("transient upload and send errors retry with fresh encryption", async () => {
    let attempts = 0;
    const files = [];
    const h = await harness({
        upload: async (_, file) => {
            files.push(file);
            if (++attempts === 1) throw new Error("network");
            return file;
        },
    });
    let sends = 0;
    h.client.sendFile = async () => {
        if (++sends === 1)
            throw Object.assign(new Error("FLOOD_WAIT"), { seconds: 1 });
        return { id: 101 };
    };
    await make(h);
    assert.equal(attempts, 3);
    assert.equal(sends, 2);
    assert.ok(h.delays.includes(1000));
    assert.equal(new Set(h.encrypted.map((x) => x.metadata.key)).size, 3);
    assert.equal(new Set(h.encrypted.map((x) => x.metadata.nonce)).size, 3);
    for (const [i, file] of files.entries()) {
        assert.equal(file.type, "application/octet-stream");
        assert.notEqual(await file.text(), "jpeg");
        assert.equal(
            await (
                await decryptPreview(file, h.encrypted[i].metadata, "thumbnail")
            ).text(),
            "jpeg",
        );
    }
    assert.deepEqual(h.deleted, []);
});

test("upload retry stops on cancellation, account switch, stale record and permanent errors", async () => {
    for (const scenario of [
        "cancel",
        "account",
        "session",
        "stale",
        "permanent",
    ]) {
        let h;
        let attempts = 0;
        const controller = new AbortController();
        h = await harness({
            upload: async () => {
                attempts++;
                if (scenario === "cancel") controller.abort();
                if (scenario === "account") h.switchAccount();
                if (scenario === "session") h.setClient({});
                if (scenario === "stale") h.records[0].thumbnail = 99;
                throw Object.assign(new Error("upload failure"), {
                    permanent: scenario === "permanent",
                });
            },
        });
        await assert.rejects(make(h, { signal: controller.signal }));
        assert.equal(attempts, 1, scenario);
        assert.equal(h.stats().sent, 0);
        assert.deepEqual(h.deleted, []);
    }
});

test("upload retries are bounded and offline does not consume budget", async () => {
    let attempts = 0;
    let offline = false;
    const h = await harness({
        online: () => {
            if (offline) {
                offline = false;
                return false;
            }
            return true;
        },
        upload: async () => {
            attempts++;
            if (attempts === 1) offline = true;
            throw new Error("network");
        },
    });
    await assert.rejects(make(h), /network/);
    assert.equal(attempts, 4);
    assert.deepEqual(h.deleted, []);
});

test("send failure stops retry after cancellation or session and record changes", async () => {
    for (const scenario of [
        "cancel",
        "account",
        "session",
        "stale",
        "permanent",
    ]) {
        const controller = new AbortController();
        const h = await harness();
        let sends = 0;
        h.client.sendFile = async () => {
            sends++;
            if (scenario === "cancel") controller.abort();
            if (scenario === "account") h.switchAccount();
            if (scenario === "session") h.setClient({});
            if (scenario === "stale") h.records[0].thumbnail = 99;
            throw Object.assign(new Error("send failure"), {
                permanent: scenario === "permanent",
            });
        };
        await assert.rejects(make(h, { signal: controller.signal }));
        assert.equal(sends, 1, scenario);
        assert.equal(h.encrypted.length, 1);
        assert.deepEqual(h.deleted, []);
    }
});

test("loader prefers full override JPEG; hold prevents early display; null cache reloads", async () => {
    const requested = [],
        revoked = [],
        downloaded = [];
    const client = {
        getMessages: async (_, { ids }) => {
            requested.push(...ids);
            return ids.map((id) => ({
                id,
                media: { document: { thumbs: [] }, id },
            }));
        },
        downloadMedia: async (media, options) => {
            downloaded.push([media.id, options]);
            return [1];
        },
    };
    const h = await load(
        "../../src/utils/thumbnails.js",
        {
            onClientChange() {},
            getClient: () => client,
            hasClient: () => true,
            isOnline: () => true,
            Blob,
            URL: {
                createObjectURL: () => "blob:jpeg",
                revokeObjectURL: (url) => revoked.push(url),
            },
            setTimeout: () => 0,
        },
        "cache,holdThumbnails,loadThumb,evictThumbnails,drain",
    );
    const old = { id: "a", file_id: 1, thumbnail: 50 };
    const next = { ...old, thumbnail: 101 };
    const release = h.holdThumbnails([old]);
    const loading = h.loadThumb(next);
    await h.drain();
    await loading;
    assert.deepEqual(requested, [50]);
    release();
    h.evictThumbnails([next]);
    assert.deepEqual(revoked, ["blob:jpeg"]);
    h.cache.set("a:1", null);
    h.evictThumbnails([next]);
    const replacement = h.loadThumb(next);
    await h.drain();
    assert.equal(await replacement, "blob:jpeg");
    assert.deepEqual(requested, [50, 101]);
    assert.deepEqual(
        downloaded.map(([id]) => id),
        [50, 101],
    );
    assert.ok(downloaded.every(([, options]) => !options.thumb));
});

test("remote pointer change invalidates cached cover without manual eviction", async () => {
    const requested = [];
    const h = await load(
        "../../src/utils/thumbnails.js",
        {
            onClientChange() {},
            hasClient: () => true,
            isOnline: () => true,
            Blob,
            getClient: () => ({
                getMessages: async (_, { ids }) => {
                    requested.push(...ids);
                    return ids.map((id) => ({ id, media: {} }));
                },
                downloadMedia: async () => [1],
            }),
            setTimeout: () => 0,
            URL: { createObjectURL: () => "jpeg", revokeObjectURL() {} },
        },
        "loadThumb,drain",
    );
    for (const thumbnail of [50, 101]) {
        const job = h.loadThumb({ id: "a", file_id: 1, thumbnail });
        await h.drain();
        await job;
    }
    assert.deepEqual(requested, [50, 101]);
});
test("scaled image uses existing JPEG 320px / quality 0.82 and closes bitmap", async () => {
    let closed = false,
        canvas,
        encoded;
    const h = await load(
        "../../src/utils/thumbnails.js",
        {
            onClientChange() {},
            createImageBitmap: async () => ({
                width: 1600,
                height: 800,
                close() {
                    closed = true;
                },
            }),
            document: {
                createElement: () =>
                    (canvas = {
                        getContext: () => ({ drawImage() {} }),
                        toBlob(fn, type, quality) {
                            encoded = [type, quality];
                            fn(new Blob(["jpeg"]));
                        },
                    }),
            },
        },
        "shrink",
    );
    await h.shrink(new Blob(), "image/jpeg");
    assert.equal(canvas.width, 320);
    assert.equal(canvas.height, 160);
    assert.deepEqual(encoded, ["image/jpeg", 0.82]);
    assert.equal(closed, true);
});

test("regeneration uploads ciphertext and preserves legacy metadata", async () => {
    const h = await harness();
    await make(h);
    assert.equal(h.stats().sent, 1);
    assert.deepEqual(h.deleted, []);
    assert.ok(
        h.records.every(
            (r) => r.thumbnail === 50 && r.thumbnailBlob.message === 101,
        ),
    );
    const { file, forceDocument, ...extra } = h.uploads[0];
    assert.equal(file.name, "cloudgram-thumbnail-v1.bin");
    assert.equal(file.type, "application/octet-stream");
    assert.equal(forceDocument, true);
    assert.deepEqual(Object.keys(extra), []);
    assert.notEqual(await file.text(), "jpeg");
    assert.equal(
        await (
            await decryptPreview(file, h.records[0].thumbnailBlob, "thumbnail")
        ).text(),
        "jpeg",
    );
});

test("failed partial save restores only matching thumbnail metadata", async () => {
    let h;
    h = await harness({
        flush: async () => {
            h.records[1].thumbData = "concurrent";
            h.records[2].thumbnailBlob = {
                ...h.records[2].thumbnailBlob,
                nonce: "replacement",
            };
            h.records[3].file_id = 2;
            throw new Error("partial save");
        },
    });
    h.records[0].thumbData = "old-a";
    h.records[1].thumbData = "old-b";
    h.records[0].thumbnailBlob = { message: 90, nonce: "old" };
    h.records.push({ id: "c", file_id: 1 }, { id: "d", file_id: 1 });
    await assert.rejects(make(h), /partial save/);
    assert.equal(h.records[0].thumbnail, 50);
    assert.equal(h.records[0].thumbData, "old-a");
    assert.equal(h.records[1].thumbData, "concurrent");
    assert.deepEqual(h.records[0].thumbnailBlob, { message: 90, nonce: "old" });
    assert.equal(h.records[1].thumbnailBlob, undefined);
    assert.equal(h.records[0].updatedAt, 2);
    assert.equal(h.records[1].updatedAt, 2);
    assert.equal(h.records[2].thumbnailBlob.nonce, "replacement");
    assert.equal(h.records[3].thumbnailBlob.message, 101);
    assert.deepEqual(h.deleted, []);
    assert.deepEqual(h.evicted, ["b", "c", "d"]);
});

test("in-place metadata change during failed save is preserved", async () => {
    let h;
    h = await harness({
        flush: async () => {
            h.records[0].thumbnailBlob.extra = "concurrent";
            throw new Error("partial save");
        },
    });
    h.records.splice(1);
    await assert.rejects(make(h), /partial save/);
    assert.equal(h.records[0].thumbnailBlob.extra, "concurrent");
    assert.deepEqual(h.deleted, []);
});

test("account change during save never rolls back another account", async () => {
    let h;
    h = await harness({
        flush: async () => {
            h.switchAccount();
            h.records[0].thumbData = "other-account";
            throw new Error("save failed");
        },
    });
    await assert.rejects(make(h), /save failed/);
    assert.equal(h.records[0].thumbData, "other-account");
    assert.equal(h.records[0].thumbnailBlob.message, 101);
    assert.deepEqual(h.deleted, []);
});

test("concurrent cover change during draw is not overwritten", async () => {
    let h;
    h = await harness({
        onSeek: () => {
            h.records[1].thumbData = "concurrent";
        },
    });
    await assert.rejects(make(h), /đã thay đổi/);
    assert.equal(h.records[1].thumbData, "concurrent");
    assert.equal(h.records[0].thumbnail, 50);
});

test("deleted or replaced source during draw cannot publish", async () => {
    for (const deleted of [true, false]) {
        let h;
        h = await harness({
            onSeek: () => {
                if (deleted) h.records.splice(0, 1);
                else h.records[0].file_id = 2;
            },
        });
        await assert.rejects(make(h), /đã thay đổi/);
        assert.equal(h.stats().sent, 0);
        assert.deepEqual(h.deleted, []);
    }
});

test("encrypted loader authenticates and changes identity for all metadata", async () => {
    const encrypted = await encryptPreview(new Blob(["jpeg"]), "thumbnail");
    let bytes = new Uint8Array(await encrypted.ciphertext.arrayBuffer());
    let downloads = 0;
    let networkFailure = false;
    const urls = [],
        revoked = [];
    const h = await load(
        "../../src/utils/thumbnails.js",
        {
            onClientChange() {},
            hasClient: () => true,
            isOnline: () => true,
            Blob,
            getClient: () => ({
                getMessages: async (_, { ids }) =>
                    ids.map((id) => ({ id, media: {} })),
                downloadMedia: async () => {
                    downloads++;
                    if (networkFailure) {
                        networkFailure = false;
                        throw new Error("network");
                    }
                    return bytes;
                },
            }),
            setTimeout: (fn) => {
                queueMicrotask(fn);
                return 1;
            },
            URL: {
                createObjectURL: (blob) => {
                    urls.push(blob);
                    return `blob:${urls.length}`;
                },
                revokeObjectURL: (url) => revoked.push(url),
            },
        },
        "loadThumb,drain",
    );
    const record = {
        id: "a",
        file_id: 1,
        thumbnail: 50,
        thumbData: "plaintext",
        thumbnailBlob: { ...encrypted.metadata, message: 101 },
    };
    assert.equal(await h.loadThumb(record), "blob:1");
    assert.equal(await urls[0].text(), "jpeg");
    networkFailure = true;
    assert.equal(await h.loadThumb({ ...record, id: "network" }), "blob:2");
    assert.equal(downloads, 3);
    bytes = bytes.slice();
    bytes[0] ^= 1;
    assert.equal(
        await h.loadThumb({
            ...record,
            thumbnailBlob: {
                ...record.thumbnailBlob,
                nonce: btoa("123456789012"),
            },
        }),
        null,
    );
    assert.deepEqual(revoked, ["blob:1"]);
    assert.equal(downloads, 4);
    assert.equal(await h.loadThumb({ ...record, thumbnailBlob: null }), null);
});

test("empty and oversized generated JPEG fail without writes", async () => {
    for (const size of [0, 200 * 1024 + 1]) {
        const h = await harness({
            image: true,
            shrink: async () =>
                new Blob([new Uint8Array(size)], { type: "image/jpeg" }),
        });
        await assert.rejects(make(h), /không hợp lệ/);
        assert.equal(h.records[0].thumbnail, 50);
        assert.equal(h.stats().sent, 0);
    }
});

test("tree data respects hold and replaces cached legacy thumbnail", async () => {
    const revoked = [];
    const h = await load(
        "../../src/utils/thumbnails.js",
        {
            onClientChange() {},
            URL: { revokeObjectURL: (url) => revoked.push(url) },
        },
        "cache,pointers,holdThumbnails,loadThumb",
    );
    const old = { id: "a", file_id: 1, thumbnail: 50 };
    h.cache.set("a:1", "blob:old");
    h.pointers.set("a:1", JSON.stringify([null, null, 50]));
    const release = h.holdThumbnails([old]);
    const next = {
        ...old,
        thumbnail: undefined,
        thumbData: "data:image/jpeg;base64,anBlZw==",
    };
    assert.equal(await h.loadThumb(next), "blob:old");
    release();
    assert.equal(await h.loadThumb(next), next.thumbData);
    assert.deepEqual(revoked, ["blob:old"]);
    assert.equal(
        await h.loadThumb({ ...next, thumbData: "new-data" }),
        "new-data",
    );
});

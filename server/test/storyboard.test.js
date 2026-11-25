import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
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
    corrupt = false,
    repeated = false,
    width = 320,
    height = 180,
    imageWidth = 1440,
    imageHeight = 810,
    metadataTimeouts = 0,
    flush = async () => {},
    upload = async () => ({}),
    fetchError = null,
    online = () => true,
    validate = async () => {},
    react = {},
} = {}) {
    const records = [
        { id: "a", file_id: 1 },
        { id: "b", file_id: 1 },
    ];
    let draws = 0;
    let sent = 0;
    let fetched = 0;
    let scope = {};
    let mode = "private";
    let activeClient;
    let savedClient;
    let clientChanged;
    const deleted = [];
    const uploads = [];
    const messages = new Map();
    const sentOptions = [];
    class ApiError extends Error {}
    const updateOptions = [];
    const delays = [];
    const client = {
        sendFile: async (_, options) => {
            sentOptions.push(options);
            const id = ++sent + 100;
            messages.set(id, options.file);
            return { id };
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
                        : 20 + (repeated ? 0 : current * 2) + (i % 32);
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
            new URL("../../src/services/storyboard.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const mod = vm.runInNewContext(
        `${source}\n;({draw,make,load,regenerate,getStoryboard,sessionState,useStoryboard,storyboardsOf})`,
        {
            ...react,
            console: { log() {} },
            Event,
            AbortController,
            DOMException,
            Blob,
            File,
            encryptPreview,
            decryptPreview,
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
            Image: class extends EventTarget {
                naturalWidth = fetched === 1 ? imageWidth : 1440;
                naturalHeight = fetched === 1 ? imageHeight : 810;
                set src(_) {
                    queueMicrotask(() =>
                        this.dispatchEvent(
                            new Event(
                                corrupt && fetched === 1 ? "error" : "load",
                            ),
                        ),
                    );
                }
            },
            ApiError,
            describeError: (error) => error?.message ?? String(error),
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
                );
            },
            flush,
            uploadParts: async (client, file) => {
                uploads.push(file);
                await upload(client, file);
                return file;
            },
            fetchFile: async (_, message) => {
                fetched++;
                if (fetchError) throw fetchError;
                return (
                    messages.get(message) ??
                    new Blob(["jpeg"], { type: "image/jpeg" })
                );
            },
            previewKind: () => "video",
        },
    );
    return {
        ...mod,
        make: (id, ...args) =>
            mod.make(
                records.find((r) => r.file_id === id),
                ...args,
            ),
        load: (record, ...args) =>
            mod.load(
                { ...records.find((r) => r.id === record.id), ...record },
                ...args,
            ),
        records,
        deleted,
        uploads,
        messages,
        sentOptions,
        ApiError,
        updateOptions,
        delays,
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
        stats: () => ({ draws, sent, fetched }),
    };
}

test("partial frames rejected before upload", async () => {
    const h = await harness({ missed: [2, 5, 8, 11, 14, 17, 20, 23, 26] });
    await assert.rejects(
        h.make(1, () => "stream", { retryDelays: [0, 0] }),
        /Too few/,
    );
    assert.equal(h.stats().sent, 0);
});

test("session validation retries API outage and fails closed on 401 or changed session", async () => {
    let calls = 0;
    const h = await harness({
        validate: async () => {
            if (++calls === 1) throw new Error("offline");
        },
    });
    await h.make(1, () => "stream", { retryDelays: [0] });
    assert.ok(calls >= 3);
    let loads = 0;
    const l = await harness({
        validate: async () => {
            if (++loads === 1) throw new Error("offline");
        },
    });
    await l.load(
        { id: "a", storyboard: { message: 50, duration: 81 } },
        { retryDelays: [0] },
    );
    assert.equal(loads, 2);
    let denied = 0;
    const d = await harness({
        validate: async () => {
            denied++;
            throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
    });
    await assert.rejects(
        d.make(1, () => "stream", { retryDelays: [0] }),
        /unauthorized/,
    );
    await assert.rejects(
        d.load(
            { id: "a", storyboard: { message: 50, duration: 81 } },
            { retryDelays: [0] },
        ),
        /unauthorized/,
    );
    assert.equal(denied, 2);
    assert.equal(d.stats().fetched, 0);
    let attempts = 0;
    const changed = await harness({
        validate: async () => {
            if (++attempts === 2) changed.replaceSavedClient();
        },
    });
    await assert.rejects(
        changed.make(1, () => "stream", { retryDelays: [0] }),
        /session/,
    );
    assert.equal(changed.stats().draws, 0);
});

test("collision across interrupted migration stays isolated and resumes on shared client", async () => {
    const h = await harness();
    h.records.push({ id: "shared", file_id: 1, tg: "shared" });
    await assert.rejects(
        h.regenerate(h.records[2], () => "shared"),
        /session/,
    );
    assert.equal(h.stats().draws, 0);
    await h.regenerate(h.records[0], () => "private");
    assert.ok(h.records[0].storyboard);
    assert.deepEqual(h.records[1].storyboard, h.records[0].storyboard);
    assert.equal(h.records[2].storyboard, undefined);
    h.setMode("shared");
    await assert.rejects(
        h.regenerate(h.records[0], () => "private"),
        /session/,
    );
    await h.regenerate(h.records[2], () => "shared");
    assert.notEqual(
        h.records[2].storyboard.message,
        h.records[0].storyboard.message,
    );
    assert.deepEqual(h.deleted, []);
});

test("session change during storyboard upload fails closed", async () => {
    let h;
    h = await harness({ upload: async () => h.setClient({}) });
    await assert.rejects(
        h.regenerate(h.records[0], () => "private"),
        /session/,
    );
    assert.equal(h.stats().sent, 0);
    assert.equal(h.records[0].storyboard, undefined);
});

test("saved session mismatch rejects before drawing storyboard", async () => {
    const h = await harness();
    h.replaceSavedClient();
    await assert.rejects(
        h.regenerate(h.records[0], () => "private"),
        /session/,
    );
    assert.equal(h.stats().draws, 0);
    assert.equal(h.stats().sent, 0);
});

test("account mode validates exact saved client session", async () => {
    const source = await readFile(
        new URL("../../src/services/account.js", import.meta.url),
        "utf8",
    );
    const fn = source
        .match(
            /export async function getTelegramMode\(client\) \{[\s\S]*?\n\}/,
        )[0]
        .replace("export ", "");
    const getMode = vm.runInNewContext(`${fn}; getTelegramMode`, {
        api: { getSession: async () => ({ session: "sealed" }) },
        decryptJson: async () => ({ session: "saved", telegramMode: "shared" }),
        dek: {},
        SESSION_LABEL: "session",
        sessionString: (client) => client.session,
    });
    assert.equal(await getMode({ session: "saved" }), "shared");
    assert.equal(await getMode({ session: "other" }), null);
    assert.equal(await getMode(), "shared");
});

test("stale storyboard source cannot join existing work", async () => {
    const h = await harness();
    const stale = { ...h.records[0], tg: "shared" };
    const job = h.regenerate(h.records[0], () => "private");
    await assert.rejects(
        h.regenerate(stale, () => "shared"),
        /changed/,
    );
    await job;
});

test("progress reaches 81 frames, then uploads and saves", async () => {
    const h = await harness();
    const progress = [];
    await h.make(1, () => "stream", { onProgress: (p) => progress.push(p) });
    assert.ok(h.updateOptions.length > 0);
    assert.ok(
        h.updateOptions.every((option) => option?.preserveModifiedAt === true),
    );
    assert.deepEqual(
        progress.filter((p) => p.phase === "drawing").map((p) => p.done),
        Array.from({ length: 82 }, (_, i) => i),
    );
    assert.deepEqual(
        [...new Set(progress.map((p) => p.phase))],
        ["drawing", "uploading", "saving"],
    );
    assert.ok(progress.every((p) => p.total === 81 && p.attempt === 1));
});

test("retry reports next attempt and resets frame progress", async () => {
    let uploads = 0;
    const h = await harness({
        upload: async () => {
            if (++uploads === 1) throw new Error("network");
            return {};
        },
    });
    const progress = [];
    await h.regenerate(h.records[0], () => "stream", {
        retryDelays: [0, 0],
        onProgress: (p) => progress.push(p),
    });
    const retry = progress.findIndex((p) => p.phase === "retrying");
    assert.equal(progress[retry - 1].done, 81);
    assert.equal(progress[retry].done, 0);
    assert.equal(progress[retry].attempt, 2);
    assert.equal(progress[retry + 1].phase, "drawing");
    assert.equal(progress[retry + 1].done, 0);
    assert.equal(progress.at(-1).attempt, 2);
});

test("queued job reports waiting; dedup listeners share live progress", async () => {
    const h = await harness();
    h.records.push({ id: "c", file_id: 2 });
    const first = h.make(1, () => "stream");
    const progress = [];
    const duplicate = [];
    const second = h.make(2, () => "stream", {
        onProgress: (p) => progress.push(p),
    });
    const joined = h.make(2, () => "unused", {
        onProgress: (p) => duplicate.push(p),
    });
    assert.equal(second, joined);
    assert.equal(progress[0].phase, "waiting");
    await Promise.all([first, second]);
    assert.deepEqual(duplicate, progress);
    assert.equal(progress.at(-1).phase, "saving");
    assert.equal(h.stats().draws, 2);
});

test("listener joining during drawing receives current frame and later phases", async () => {
    const h = await harness();
    const progress = [];
    let joined;
    const job = h.make(1, () => "stream", {
        onProgress: (p) => {
            if (p.phase === "drawing" && p.done === 35)
                joined = h.make(1, () => "unused", {
                    onProgress: (next) => progress.push(next),
                });
        },
    });
    await job;
    assert.equal(joined, job);
    assert.equal(progress[0].done, 35);
    assert.ok(progress.some((p) => p.phase === "drawing" && p.done === 81));
    assert.equal(progress.at(-1).phase, "saving");
    assert.equal(h.stats().draws, 1);
});

test("omitting progress callback preserves result and side effects", async () => {
    const plain = await harness();
    const observed = await harness();
    const a = await plain.make(1, () => "stream");
    const b = await observed.make(1, () => "stream", { onProgress() {} });
    assert.equal(a.message, b.message);
    assert.equal(a.duration, b.duration);
    assert.deepEqual(plain.stats(), observed.stats());
    // VM objects have separate prototypes; compare the persisted record data.
    assert.equal(
        plain.records[0].storyboard.v,
        observed.records[0].storyboard.v,
    );
});

test("blank frames rejected; dark opening passes", async () => {
    const blank = await harness({ black: true });
    await assert.rejects(
        blank.make(1, () => "stream", { retryDelays: [0, 0] }),
        /Blank/,
    );
    assert.equal(blank.stats().sent, 0);
    const dark = await harness({ dark: true });
    await dark.make(1, () => "stream");
    assert.equal(dark.stats().sent, 1);
});

test("transient network errors retry then succeed", async () => {
    const h = await harness({
        errors: [
            Object.assign(new Error("network"), { code: 2 }),
            new Error("stream error"),
        ],
    });
    await h.make(1, () => "stream");
    assert.equal(h.stats().draws, 3);
    assert.ok(h.delays.includes(2000));
    assert.ok(h.delays.includes(5000));
    assert.equal(h.sessionState().failed.has(1), false);
});

test("exhausted retries mark file failed", async () => {
    const h = await harness({
        errors: Array.from(
            { length: 3 },
            () => new Error("metadata timed out"),
        ),
    });
    await assert.rejects(
        h.make(1, () => "stream", { retryDelays: [0, 0] }),
        /timed out/,
    );
    assert.equal(h.stats().draws, 3);
    assert.equal(
        h.sessionState().failed.has(JSON.stringify(["private", 1])),
        true,
    );
    await assert.rejects(
        h.getStoryboard(h.records[0], () => "stream", true),
        /đã lỗi/,
    );
    assert.equal(h.stats().draws, 3);
});

for (const code of [3, 4])
    test(`decode error ${code} fails immediately`, async () => {
        const h = await harness({
            errors: [Object.assign(new Error("cannot decode"), { code })],
        });
        await assert.rejects(
            h.make(1, () => "stream"),
            /cannot decode/,
        );
        assert.equal(h.stats().draws, 1);
        assert.equal(h.stats().sent, 0);
    });

for (const duration of [Infinity, NaN, 0, -1])
    test(`invalid duration ${duration} fails immediately`, async () => {
        const h = await harness({ duration });
        await assert.rejects(
            h.make(1, () => "stream"),
            /Invalid duration/,
        );
        assert.equal(h.stats().draws, 1);
        assert.equal(h.stats().sent, 0);
    });

function oldStoryboard(h) {
    for (const r of h.records) r.storyboard = { message: 50, duration: 81 };
}

test("regenerate failure keeps old pointer and message", async () => {
    const h = await harness({ black: true });
    oldStoryboard(h);
    await assert.rejects(
        h.regenerate(h.records[0], () => "stream", { retryDelays: [0, 0] }),
    );
    assert.ok(h.records.every((r) => r.storyboard.message === 50));
    assert.deepEqual(h.deleted, []);
});

for (const referenced of [false, true])
    test(`regenerate swaps linked pointers; old still referenced=${referenced}`, async () => {
        const h = await harness();
        oldStoryboard(h);
        if (referenced)
            h.records.push({
                id: "other",
                file_id: 2,
                storyboard: { message: 50, duration: 81 },
            });
        await h.regenerate(h.records[0], () => "stream");
        assert.ok(
            h.records
                .filter((r) => r.file_id === 1)
                .every((r) => r.storyboard.message === 101),
        );
        assert.deepEqual(h.deleted, []);
    });

test("concurrent regeneration deduplicates", async () => {
    const h = await harness();
    oldStoryboard(h);
    const a = h.regenerate(h.records[0], () => "stream");
    const b = h.regenerate(h.records[1], () => "stream");
    assert.equal(a, b);
    await Promise.all([a, b]);
    assert.equal(h.stats().draws, 1);
    assert.equal(h.stats().sent, 1);
});

test("abort during seek stops work and writes nothing", async () => {
    const h = await harness({ missed: [0] });
    const controller = new AbortController();
    const job = h.make(
        1,
        () => {
            queueMicrotask(() => controller.abort());
            return "stream";
        },
        { signal: controller.signal },
    );
    await assert.rejects(job, { name: "AbortError" });
    assert.equal(h.stats().sent, 0);
    assert.ok(h.records.every((r) => !r.storyboard));
    assert.equal(h.sessionState().failed.has(1), false);
});

for (const queued of [false, true])
    test(`live dedup waiter retries after owner abort; queued=${queued}`, async () => {
        const h = await harness();
        h.records.push({ id: "c", file_id: 2 });
        const blocker = queued ? h.make(2, () => "stream") : null;
        const owner = new AbortController();
        const waiter = new AbortController();
        const job = h.make(1, () => "owner", {
            signal: owner.signal,
            onProgress: (p) => {
                if (!queued && p.phase === "drawing" && p.done === 1)
                    owner.abort();
            },
        });
        const rejected = assert.rejects(job, { name: "AbortError" });
        const progress = [];
        const joined = h.make(1, () => "waiter", {
            signal: waiter.signal,
            onProgress: (p) => progress.push(p),
        });
        if (queued) owner.abort();
        const board = await joined;
        await rejected;
        await blocker;
        assert.equal(waiter.signal.aborted, false);
        assert.equal(board.duration, 81);
        assert.equal(h.records[0].storyboard.message, board.message);
        assert.equal(progress.at(-1).phase, "saving");
        assert.equal(h.stats().sent, queued ? 2 : 1);
        assert.equal(h.stats().draws, 2);
        assert.equal(h.sessionState().failed.has(1), false);
    });

test("dedup waiter does not retry across accounts or after its own abort", async () => {
    for (const changedAccount of [false, true]) {
        const h = await harness();
        const owner = new AbortController();
        const waiter = new AbortController();
        const job = h.make(1, () => "owner", { signal: owner.signal });
        const rejected = assert.rejects(job, { name: "AbortError" });
        const joined = h.make(1, () => "waiter", { signal: waiter.signal });
        const joinedRejected = assert.rejects(joined, { name: "AbortError" });
        if (changedAccount) h.switchAccount();
        else waiter.abort();
        owner.abort();
        await Promise.all([rejected, joinedRejected]);
        assert.equal(h.stats().sent, 0);
        assert.ok(h.records.every((r) => !r.storyboard));
    }
});

test("account change before upload writes nothing", async () => {
    const h = await harness();
    await assert.rejects(
        h.make(1, () => {
            h.switchAccount();
            return "stream";
        }),
        { name: "AbortError" },
    );
    assert.equal(h.stats().sent, 0);
    assert.ok(h.records.every((r) => !r.storyboard));
});

test("corrupt stored sprite regenerates once instead of redownloading", async () => {
    const h = await harness({ corrupt: true });
    oldStoryboard(h);
    const board = await h.getStoryboard(h.records[0], () => "stream", true);
    assert.equal(board.duration, 81);
    await h.getStoryboard(h.records[0], () => "stream", true);
    assert.equal(h.stats().draws, 1);
    assert.equal(h.stats().fetched, 2);
    assert.equal(h.records[0].storyboard.message, 101);
});

test("identical nonblack cells rejected before upload", async () => {
    const h = await harness({ repeated: true });
    await assert.rejects(
        h.make(1, () => "stream", { retryDelays: [] }),
        /repeated/,
    );
    assert.equal(h.stats().sent, 0);
});

for (const dimensions of [{ width: 0 }, { height: 0 }, { width: Infinity }])
    test(`invalid dimensions ${JSON.stringify(dimensions)}`, async () => {
        const h = await harness(dimensions);
        await assert.rejects(
            h.make(1, () => "stream"),
            /dimensions/,
        );
        assert.equal(h.stats().draws, 1);
        assert.equal(h.stats().sent, 0);
    });

test("actual metadata timeout retries then succeeds", async () => {
    const h = await harness({ metadataTimeouts: 2 });
    await h.make(1, () => "stream", { retryDelays: [0, 0] });
    assert.equal(h.stats().draws, 3);
    assert.equal(h.stats().sent, 1);
});

test("FLOOD_WAIT and offline do not spend attempts", async () => {
    let polls = 0;
    const h = await harness({
        online: () => ++polls > 3,
        errors: [
            Object.assign(new Error("FLOOD_WAIT"), { seconds: 1 }),
            new Error("network"),
            new Error("network"),
        ],
    });
    await h.make(1, () => "stream");
    assert.equal(h.stats().draws, 4);
    assert.equal(h.stats().sent, 1);
    assert.ok(h.delays.includes(1000));
});

test("transient upload failure retries without failing file", async () => {
    let attempts = 0;
    const h = await harness({
        upload: async () => {
            if (++attempts < 3) throw new Error("network");
            return {};
        },
    });
    await h.make(1, () => "stream", { retryDelays: [0, 0] });
    assert.equal(attempts, 3);
    assert.equal(h.stats().sent, 1);
});

test("tree save failure restores old pointers and retains old message", async () => {
    const h = await harness({
        flush: async () => {
            throw new Error("tree unavailable");
        },
    });
    oldStoryboard(h);
    await assert.rejects(
        h.regenerate(h.records[0], () => "stream"),
        /tree unavailable/,
    );
    assert.ok(h.records.every((r) => r.storyboard.message === 50));
    assert.deepEqual(h.deleted, []);
});

test("account changes while sending: no tree write, retain sent message", async () => {
    const h = await harness();
    h.client.sendFile = async () => {
        h.switchAccount();
        return { id: 77 };
    };
    await assert.rejects(
        h.make(1, () => "stream"),
        { name: "AbortError" },
    );
    assert.ok(h.records.every((r) => !r.storyboard));
    assert.deepEqual(h.deleted, []);
});

test("lease loss stops active generation", async () => {
    const h = await harness();
    await assert.rejects(
        h.make(1, () => {
            queueMicrotask(() => h.clientChanged(null));
            return "stream";
        }),
        { name: "AbortError" },
    );
    assert.equal(h.stats().sent, 0);
    assert.ok(h.records.every((r) => !r.storyboard));
});

for (const invalid of [{ imageWidth: 1439 }, { imageHeight: 809 }])
    test(`invalid stored grid regenerates: ${JSON.stringify(
        invalid,
    )}`, async () => {
        const h = await harness(invalid);
        oldStoryboard(h);
        await h.getStoryboard(h.records[0], () => "stream", true);
        assert.equal(h.stats().draws, 1);
        assert.equal(h.records[0].storyboard.message, 101);
    });

test("invalid stored duration regenerates without downloading old sprite", async () => {
    const h = await harness();
    oldStoryboard(h);
    for (const r of h.records) r.storyboard.duration = Infinity;
    await h.getStoryboard(h.records[0], () => "stream", true);
    assert.equal(h.stats().fetched, 1);
    assert.equal(h.stats().draws, 1);
});

test("failed corrupt-sprite recovery is not retried on each open", async () => {
    const h = await harness({ corrupt: true, black: true });
    oldStoryboard(h);
    await assert.rejects(
        h.getStoryboard(h.records[0], () => "stream", true, {
            retryDelays: [0, 0],
        }),
    );
    await assert.rejects(h.getStoryboard(h.records[0], () => "stream", true));
    assert.equal(h.stats().fetched, 1);
    assert.equal(h.stats().draws, 3);
});

test("sprite download network failure does not replace old sprite", async () => {
    const h = await harness({ fetchError: new Error("network") });
    oldStoryboard(h);
    await assert.rejects(
        h.getStoryboard(h.records[0], () => "stream", true),
        /network/,
    );
    assert.equal(h.stats().draws, 0);
    assert.equal(h.records[0].storyboard.message, 50);
});

test("message-id cache is scoped by account", async () => {
    const h = await harness();
    oldStoryboard(h);
    await h.load(h.records[0]);
    h.switchAccount();
    await h.load(h.records[0]);
    assert.equal(h.stats().fetched, 2);
});

// Small hook runner: keep effect cleanup/order and state across pointer renders.
function hookRunner() {
    const slots = [];
    let index = 0;
    let pending = [];
    return {
        react: {
            useState(initial) {
                const i = index++;
                slots[i] ??= { value: initial };
                return [
                    slots[i].value,
                    (value) => {
                        slots[i].value = value;
                    },
                ];
            },
            useRef(initial) {
                const i = index++;
                return (slots[i] ??= { current: initial });
            },
            useEffect(effect, deps) {
                const i = index++;
                const old = slots[i];
                if (!old || deps.some((dep, n) => dep !== old.deps[n])) {
                    pending.push(() => {
                        old?.cleanup?.();
                        slots[i] = { deps, cleanup: effect() };
                    });
                }
            },
        },
        render(h, record) {
            index = 0;
            const value = h.useStoryboard(record, () => "stream", true);
            const effects = pending;
            pending = [];
            for (const effect of effects) effect();
            return value;
        },
        close() {
            for (const slot of slots) slot?.cleanup?.();
        },
    };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const rebuild of [false, true])
    test(`player ignores foreign AbortError; rebuild=${rebuild}`, async () => {
        const runner = hookRunner();
        const error = new DOMException("Storyboard cancelled", "AbortError");
        const h = await harness({
            react: runner.react,
            fetchError: rebuild ? null : error,
            flush: async () => {
                throw error;
            },
        });
        oldStoryboard(h);
        runner.render(h, h.records[0]);
        const loading = [...h.sessionState().loaded.values()][0];
        if (rebuild) await loading;
        else await assert.rejects(loading, { name: "AbortError" });
        await tick();
        if (rebuild) await runner.render(h, h.records[0])[3]();
        await tick();
        const after = runner.render(h, h.records[0]);
        assert.equal(after[2], null);
        assert.equal(after[1], false);
        assert.equal(after[4], null);
        assert.equal(h.records[0].storyboard.message, 50);
        runner.close();
    });

test("automatic current-video generation keeps progress through tree publication", async () => {
    const runner = hookRunner();
    let finish;
    let began;
    const started = new Promise((resolve) => {
        began = resolve;
    });
    const saving = new Promise((resolve) => {
        finish = resolve;
    });
    const h = await harness({
        react: runner.react,
        flush: () => {
            began();
            return saving;
        },
    });
    runner.render(h, h.records[0]);
    await started;
    const during = runner.render(h, h.records[0]);
    assert.equal(during[1], true);
    assert.equal(during[5].phase, "saving");
    assert.equal(during[5].done, 81);
    finish();
    await tick();
    await tick();
    const after = runner.render(h, h.records[0]);
    assert.equal(after[1], false);
    assert.ok(after[0]);
    runner.close();
});

for (const fail of [false, true])
    test(`player keeps old board during rebuild; failure=${fail}`, async () => {
        const runner = hookRunner();
        let finish;
        let began;
        const started = new Promise((resolve) => {
            began = resolve;
        });
        const saving = new Promise((resolve, reject) => {
            finish = () =>
                fail ? reject(new Error("tree unavailable")) : resolve();
        });
        const h = await harness({
            react: runner.react,
            flush: () => {
                began();
                return saving;
            },
        });
        oldStoryboard(h);
        runner.render(h, h.records[0]);
        // Fetch/image decode complete without wall-clock timing assumptions.
        await tick();
        await tick();
        const before = runner.render(h, h.records[0]);
        assert.ok(before[0]);
        const rebuilding = before[3]();
        await started;
        // Simulate React observing the newly published tree pointer during flush.
        const during = runner.render(h, h.records[0]);
        assert.equal(during[0], before[0]);
        assert.equal(during[1], true);
        assert.equal(during[5].phase, "saving");
        finish();
        await rebuilding;
        await tick();
        const after = runner.render(h, h.records[0]);
        assert.equal(after[1], false);
        if (fail) {
            assert.equal(after[0], before[0]);
            assert.match(after[2], /tree unavailable/);
            assert.equal(h.records[0].storyboard.message, 50);
            assert.deepEqual(h.deleted, []);
        } else {
            assert.ok(after[4]);
            assert.equal(h.records[0].storyboard.message, 101);
            assert.deepEqual(h.deleted, []);
        }
        runner.close();
    });

test("player close aborts rebuild and leaves old pointer", async () => {
    const runner = hookRunner();
    let prepared;
    const preparing = new Promise((resolve) => {
        prepared = resolve;
    });
    let finish;
    const upload = new Promise((resolve) => {
        finish = resolve;
    });
    const h = await harness({
        react: runner.react,
        upload: () => {
            prepared();
            return upload;
        },
    });
    oldStoryboard(h);
    runner.render(h, h.records[0]);
    await tick();
    await tick();
    const rebuilding = runner.render(h, h.records[0])[3]();
    await preparing;
    runner.close();
    finish({});
    await rebuilding;
    assert.equal(h.records[0].storyboard.message, 50);
    assert.equal(h.stats().sent, 0);
    assert.deepEqual(h.deleted, []);
});

test("73 of 81 cells pass the 90% boundary", async () => {
    const h = await harness({ missed: [2, 5, 8, 11, 14, 17, 20, 23] });
    await h.make(1, () => "stream");
    assert.equal(h.stats().sent, 1);
});

test("partial frames on first attempt retry then succeed", async () => {
    const h = await harness({
        missed: (attempt, index) =>
            attempt === 1 && [2, 5, 8, 11, 14, 17, 20, 23, 26].includes(index),
    });
    await h.make(1, () => "stream");
    assert.equal(h.stats().draws, 2);
    assert.equal(h.stats().sent, 1);
});

test("stuck seek retries then succeeds", async () => {
    const h = await harness({ missed: (attempt) => attempt < 3 });
    await h.make(1, () => "stream");
    assert.equal(h.stats().draws, 3);
    assert.equal(h.stats().sent, 1);
});

test("player video change cancels pending generation", async () => {
    const runner = hookRunner();
    let prepared;
    const preparing = new Promise((resolve) => {
        prepared = resolve;
    });
    let finish;
    const upload = new Promise((resolve) => {
        finish = resolve;
    });
    const h = await harness({
        react: runner.react,
        upload: () => {
            prepared();
            return upload;
        },
    });
    oldStoryboard(h);
    runner.render(h, h.records[0]);
    await tick();
    await tick();
    const rebuilding = runner.render(h, h.records[0])[3]();
    await preparing;
    runner.render(h, {
        id: "other-video",
        file_id: 2,
        storyboard: { message: 50, duration: 81 },
    });
    finish({});
    await rebuilding;
    assert.equal(h.records[0].storyboard.message, 50);
    assert.equal(h.stats().sent, 0);
    runner.close();
});

for (const linked of [false, true])
    test(`deleteForever retains referenced sprite: ${linked}`, async () => {
        const h = await harness();
        oldStoryboard(h);
        h.records[1].file_id = 2;
        if (!linked) delete h.records[1].storyboard;
        const source = (
            await readFile(
                new URL("../../src/utils/driveActions.js", import.meta.url),
                "utf8",
            )
        )
            .replace(/^import [\s\S]*?;\r?\n/gm, "")
            .replace(/\bexport /g, "");
        const deleted = [];
        const actions = vm.runInNewContext(`${source}\n;({deleteForever})`, {
            getSnapshot: () => ({ records: h.records }),
            withConverted: (ids) => ids,
            collectSubtree: (_, id) => h.records.filter((r) => r.id === id),
            recordIdsOf: (rs) => rs.map((r) => r.id),
            messageIdsOf: (rs) => rs.map((r) => r.file_id),
            messagesOf: (r) => [r.file_id],
            cancelUploads() {},
            dropShares: async () => {},
            storyboardsOf: h.storyboardsOf,
            getClient: () => ({
                deleteMessages: async (_, ids) => deleted.push(...ids),
            }),
            removeRecords: async () => {},
        });
        await actions.deleteForever(["a"]);
        assert.deepEqual(deleted, linked ? [1] : [1, 50]);
    });

test("stale player action cannot regenerate into another account", async () => {
    const runner = hookRunner();
    const h = await harness({ react: runner.react });
    oldStoryboard(h);
    runner.render(h, h.records[0]);
    await tick();
    await tick();
    const rebuild = runner.render(h, h.records[0])[3];
    h.switchAccount();
    await rebuild();
    assert.equal(h.stats().draws, 0);
    assert.equal(h.stats().sent, 0);
    assert.equal(h.records[0].storyboard.message, 50);
    runner.close();
});

test("ciphertext roundtrip, legacy read and tamper rejection", async () => {
    const h = await harness();
    const meta = await h.make(1, () => "stream");
    assert.equal(h.uploads[0].type, "application/octet-stream");
    assert.equal(h.uploads[0].name, "cloudgram-storyboard-v1.bin");
    assert.deepEqual(Object.keys(h.sentOptions[0]).sort(), [
        "file",
        "forceDocument",
    ]);
    assert.equal(h.sentOptions[0].forceDocument, true);
    assert.notEqual(await h.uploads[0].text(), "jpeg");
    assert.equal(
        await (await decryptPreview(h.uploads[0], meta, "storyboard")).text(),
        "jpeg",
    );
    await h.load(h.records[0]);
    await h.load({ id: "a", storyboard: { message: 50, duration: 81 } });
    await assert.rejects(h.load({ id: "a", storyboard: { ...meta, v: 2 } }));
    await assert.rejects(
        h.load({ id: "a", storyboard: { ...meta, key: "bad" } }),
    );
    h.messages.set(meta.message, new Blob([new Uint8Array(40)]));
    await assert.rejects(
        h.load({
            id: "a",
            storyboard: { ...meta, nonce: btoa("123456789012") },
        }),
    );
});
test("each upload attempt has fresh encryption", async () => {
    let n = 0;
    const h = await harness({
        upload: async () => {
            if (++n === 1) throw new Error("retry");
        },
    });
    const meta = await h.make(1, () => "stream", { retryDelays: [0] });
    assert.equal(h.uploads.length, 2);
    assert.notDeepEqual(
        await h.uploads[0].arrayBuffer(),
        await h.uploads[1].arrayBuffer(),
    );
    assert.equal(meta.v, 1);
    await assert.rejects(decryptPreview(h.uploads[0], meta, "storyboard"));
});
test("partial rejected flush keeps both messages", async () => {
    let h;
    h = await harness({
        flush: async () => {
            const e = new h.ApiError("partial");
            e.status = 400;
            throw e;
        },
    });
    oldStoryboard(h);
    await assert.rejects(
        h.regenerate(h.records[0], () => "stream"),
        /partial/,
    );
    assert.deepEqual(h.deleted, []);
    assert.ok(h.messages.has(101));
});

for (const change of ["identity", "delete", "replace", "add linked"]) {
    test(`generation detects concurrent ${change}`, async () => {
        let h;
        h = await harness({
            upload: async () => {
                if (change === "identity")
                    h.records[0].storyboard.duration = 42;
                if (change === "delete") h.records.splice(0, 1);
                if (change === "replace") h.records[0].file_id = 2;
                if (change === "add linked")
                    h.records.push({ id: "c", file_id: 1 });
            },
        });
        oldStoryboard(h);
        await assert.rejects(
            h.regenerate(h.records[0], () => "stream"),
            /changed/,
        );
        assert.equal(h.updateOptions.length, 0);
        assert.equal(h.messages.has(101), change === "add linked");
        assert.deepEqual(h.deleted, []);
    });
}

test("partial flush rollback preserves concurrently replaced records and metadata", async () => {
    let h;
    h = await harness({
        flush: async () => {
            h.records[0].file_id = 2;
            h.records[1].storyboard = {
                ...h.records[1].storyboard,
                nonce: "changed",
            };
            throw new Error("partial");
        },
    });
    oldStoryboard(h);
    await assert.rejects(
        h.regenerate(h.records[0], () => "stream"),
        /partial/,
    );
    assert.equal(h.records[0].storyboard.message, 101);
    assert.equal(h.records[1].storyboard.nonce, "changed");
    assert.deepEqual(h.deleted, []);
});

test("bad encrypted identity permits corrected metadata and regeneration", async () => {
    const h = await harness();
    const meta = await h.make(1, () => "stream");
    const wrong = { ...meta, key: btoa("x".repeat(32)) };
    await assert.rejects(
        h.load({ id: "a", storyboard: wrong }),
        /Invalid encrypted/,
    );
    const fetched = h.stats().fetched;
    await assert.rejects(
        h.load({ id: "a", storyboard: wrong }),
        /Bad storyboard/,
    );
    assert.equal(h.stats().fetched, fetched);
    await h.load({ id: "a", storyboard: meta });
    h.records.forEach((r) => (r.storyboard = wrong));
    await h.getStoryboard(h.records[0], () => "stream", true);
    assert.equal(h.records[0].storyboard.message, 102);
    assert.deepEqual(h.deleted, []);
});

test("tampered ciphertext and incomplete metadata are permanent, network is retryable", async () => {
    const h = await harness();
    const meta = await h.make(1, () => "stream");
    h.messages.set(meta.message, new Blob([new Uint8Array(40)]));
    await assert.rejects(
        h.load({ id: "a", storyboard: meta }),
        /Invalid encrypted/,
    );
    await assert.rejects(
        h.load({
            id: "a",
            storyboard: { message: 4, duration: 81, key: meta.key },
        }),
        /Invalid encrypted/,
    );
    await assert.rejects(
        h.load({
            id: "a",
            storyboard: { message: meta.message, duration: 81 },
        }),
        /Invalid legacy storyboard type/,
    );
    const network = await harness({ fetchError: new Error("network") });
    const record = { id: "a", storyboard: meta };
    await assert.rejects(network.load(record, { retryDelays: [0] }), /network/);
    await assert.rejects(network.load(record, { retryDelays: [] }), /network/);
    assert.equal(network.stats().fetched, 3);
    assert.equal(network.sessionState().bad.size, 0);
});

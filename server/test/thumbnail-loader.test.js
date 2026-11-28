import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (
    await readFile(
        new URL("../../src/utils/thumbnails.js", import.meta.url),
        "utf8",
    )
)
    .replace(/^import[\s\S]*?from "[^"]+";\s*/gm, "")
    .replace(/export /g, "")
    .replace(/const RETRY_DELAYS = \[[^\]]*\]/, "const RETRY_DELAYS = []");
let client;
const loader = vm.runInNewContext(
    `${source}\n({ loadThumb, THUMB_NONE, watchThumbBackfill })`,
    {
        getClient: () => client,
        hasClient: () => true,
        isOnline: () => true,
        onClientChange: () => {},
        thumbUrl: async () => null,
        decryptPreview: async () => {
            throw Error("decrypt");
        },
        structuredClone,
        Blob,
        URL,
        setTimeout,
        console,
    },
);
const record = (id, extra = {}) => ({
    id,
    file_id: id,
    name: "a.mp4",
    ...extra,
});

test("only confirmed absent thumbnails return none", async () => {
    client = {
        getMessages: async (_peer, { ids }) =>
            ids.map((id) => ({ id, media: { document: { thumbs: [] } } })),
    };
    assert.equal(await loader.loadThumb(record(1)), loader.THUMB_NONE);
    assert.equal(
        await loader.loadThumb(record(2, { enc: {}, thumbData: null })),
        loader.THUMB_NONE,
    );
    assert.equal(
        await loader.loadThumb(record(3, { thumbRef: "missing" })),
        null,
    );
    client.getMessages = async () => {
        throw Error("network");
    };
    assert.equal(await loader.loadThumb(record(4)), null);
    let missingRequests = 0;
    client.getMessages = async () => {
        missingRequests++;
        return [];
    };
    assert.equal(await loader.loadThumb(record(5)), null);
    assert.equal(await loader.loadThumb(record(5)), null);
    assert.equal(missingRequests, 1);
    assert.equal(
        await loader.loadThumb(record(8, { enc: {}, thumbnailBlob: null })),
        null,
    );
    assert.equal(missingRequests, 1);
    client.getMessages = async (_p, { ids }) => [{ id: ids[0], media: {} }];
    client.downloadMedia = async () => new Uint8Array([1]);
    assert.equal(
        await loader.loadThumb(record(6, { thumbnailBlob: { message: 6 } })),
        null,
    );
});

test("onDone clears absent cache so next load sees new thumbnail", async () => {
    let callback;
    const item = record(7);
    const unsubscribe = loader.watchThumbBackfill({
        onDone: (fn) => {
            callback = fn;
            return () => {};
        },
    });
    client = {
        getMessages: async () => [
            { id: 7, media: { document: { thumbs: [] } } },
        ],
    };
    assert.equal(await loader.loadThumb(item), loader.THUMB_NONE);
    client.getMessages = async () => [
        { id: 7, media: { document: { thumbs: [{ type: "m" }] } } },
    ];
    client.downloadMedia = async () => new Uint8Array([1]);
    callback(99);
    assert.equal(await loader.loadThumb(item), loader.THUMB_NONE);
    callback(7);
    assert.match(await loader.loadThumb(item), /^blob:/);
    unsubscribe();
});

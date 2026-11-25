import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Owners } from "../owners.js";
import { TelegramProxy, gramTelegram } from "../tg-proxy.js";
import { Api } from "telegram";
import bigInt from "big-integer";

const doc = {
    id: 4,
    accessHash: 1,
    fileReference: Buffer.from("x"),
    size: 3,
    mimeType: "text/plain",
    attributes: [{ className: "DocumentAttributeFilename", fileName: "x" }],
    thumbs: [
        { type: "a", w: 5, h: 5 },
        { type: "b", w: 9, h: 9 },
    ],
};
const message = { id: 7, date: 1, message: "", document: doc };
async function fixture(fn, limits) {
    const dir = await mkdtemp(join(tmpdir(), "proxy-"));
    const owners = await new Owners(dir).open();
    const telegram = {
        savePart: async () => true,
        send: async () => message,
        getMessages: async (ids) => (ids.includes(7) ? [message] : []),
        getFile: async () => Buffer.alloc(0),
        deleteMessages: async () => {},
    };
    let time = 0;
    const proxy = new TelegramProxy({
        owners,
        telegram,
        now: () => time,
        limits,
    });
    try {
        await fn({
            proxy,
            owners,
            telegram,
            tick: (n) => {
                time += n;
            },
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
const code = (expected) => (e) => e.code === expected;

test("GramJS adapter builds Telegram requests with supplied metadata", async () => {
    const requests = [];
    let sent;
    const adapter = gramTelegram({
        invoke: async (request) => {
            requests.push(request);
            return { bytes: Buffer.from("x") };
        },
        sendFile: async (peer, opts) => {
            sent = { peer, ...opts };
            return message;
        },
    });
    const upload = { fileId: bigInt(5), parts: 2, big: true };
    await adapter.savePart(upload, 1, Buffer.from("x"));
    assert.ok(requests[0] instanceof Api.upload.SaveBigFilePart);
    assert.equal(requests[0].fileTotalParts, 2);
    await adapter.send(upload, { name: "x", mime: "text/custom" });
    assert.ok(sent.file instanceof Api.InputMediaUploadedDocument);
    assert.ok(sent.file.file instanceof Api.InputFileBig);
    assert.equal(sent.file.mimeType, "text/custom");
    await adapter.getFile(doc, 4096, 4096);
    assert.ok(requests[1] instanceof Api.upload.GetFile);
    assert.equal(requests[1].precise, true);
});

test("upload validates parts, finishes before ownership and deletes owned ids", async () =>
    fixture(async ({ proxy, owners, telegram }) => {
        await assert.rejects(
            proxy.startUpload("a", { size: 1, parts: 2 }),
            code("bad_size"),
        );
        const { uploadId } = await proxy.startUpload("a", {
            size: 3,
            parts: 1,
        });
        await assert.rejects(
            proxy.putPart("a", uploadId, 0, Buffer.alloc(2)),
            code("bad_chunk"),
        );
        await assert.rejects(
            proxy.finishUpload("a", uploadId, {
                name: "x",
                mime: "text/plain",
            }),
            code("chunk_missing"),
        );
        assert.equal(owners.count("a"), 0);
        await proxy.putPart("a", uploadId, 0, Buffer.alloc(3));
        assert.equal(owners.count("a"), 0);
        assert.equal(
            (
                await proxy.finishUpload("a", uploadId, {
                    name: "x",
                    mime: "text/plain",
                })
            ).message.id,
            7,
        );
        assert.deepEqual(
            (await proxy.messages("a", [7, 8])).messages.map(
                (m) => m?.id ?? null,
            ),
            [7, null],
        );
        assert.deepEqual((await proxy.messages("b", [7])).messages, [null]);
        await assert.rejects(proxy.readFile("b", 7, 0, 1), code("not_found"));
        let deleted;
        telegram.deleteMessages = async (ids) => {
            deleted = ids;
        };
        assert.deepEqual(await proxy.deleteMessages("a", [8, 7]), {
            deleted: [7],
        });
        assert.deepEqual(deleted, [7]);
        assert.equal(owners.count("a"), 0);
    }));

test("aligned reads cross window, retry file reference once and select largest thumbnail", async () =>
    fixture(async ({ proxy, owners, telegram }) => {
        await owners.add("a", 7);
        const calls = [];
        let fail = true;
        telegram.getFile = async (_doc, offset, limit, thumb) => {
            calls.push([offset, limit, thumb]);
            if (fail) {
                fail = false;
                throw new Error("FILE_REFERENCE_EXPIRED");
            }
            return Buffer.from(
                Array.from({ length: limit }, (_, i) => (offset + i) % 251),
            );
        };
        const result = await proxy.readFile("a", 7, 1048570, 20);
        assert.deepEqual(
            [...result],
            Array.from({ length: 20 }, (_, i) => (1048570 + i) % 251),
        );
        assert.deepEqual(calls.slice(0, 3), [
            [1044480, 4096, ""],
            [1044480, 4096, ""],
            [1048576, 4096, ""],
        ]);
        await proxy.thumb("a", 7);
        assert.equal(calls.at(-1)[2], "b");
        telegram.getFile = async () => {
            throw new Error("FILE_REFERENCE_EXPIRED");
        };
        await assert.rejects(
            proxy.readFile("a", 7, 0, 1),
            code("telegram_failed"),
        );
    }));

test("flood, concurrency and expiry limits", async () =>
    fixture(
        async ({ proxy, telegram, tick }) => {
            const first = await proxy.startUpload("a", { size: 1, parts: 1 });
            await assert.rejects(
                proxy.startUpload("a", { size: 1, parts: 1 }),
                code("busy"),
            );
            tick(10);
            await assert.rejects(
                proxy.putPart("a", first.uploadId, 0, Buffer.alloc(1)),
                code("not_found"),
            );
            const second = await proxy.startUpload("a", { size: 1, parts: 1 });
            telegram.savePart = async () => {
                throw Object.assign(new Error("FLOOD_WAIT_12"), {
                    seconds: 12,
                });
            };
            await assert.rejects(
                proxy.putPart("a", second.uploadId, 0, Buffer.alloc(1)),
                (e) =>
                    e.code === "telegram_busy" &&
                    e.status === 503 &&
                    e.extra.seconds === 12,
            );
            let release;
            telegram.savePart = () =>
                new Promise((resolve) => {
                    release = resolve;
                });
            const pending = proxy.putPart(
                "a",
                second.uploadId,
                0,
                Buffer.alloc(1),
            );
            await assert.rejects(proxy.messages("a", []), code("busy"));
            release(true);
            await pending;
        },
        { uploads: 1, requests: 1, ttl: 10 },
    ));

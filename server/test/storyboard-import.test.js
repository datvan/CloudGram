import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("Telegram import skips only reserved storyboard names", async () => {
    class Filename {
        constructor(fileName) {
            this.fileName = fileName;
        }
    }
    const names = [
        "storyboard.jpg",
        "cloudgram-storyboard-v1.bin",
        "cloudgram-thumbnail-v1.bin",
        "preview.bin",
        "cloudgram-storyboard-v2.bin",
        "my-storyboard.jpg",
    ];
    const messages = names.map((name, id) => ({
        id: id + 1,
        date: 100,
        media: { document: { attributes: [new Filename(name)] } },
    }));
    const added = [];
    const source = (
        await readFile(
            new URL("../../src/services/treeBackup.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    const { importFromTelegram } = vm.runInNewContext(
        `${source}\n;({importFromTelegram})`,
        {
            Api: { DocumentAttributeFilename: Filename },
            getSnapshot: () => ({ records: [] }),
            messagesOf: () => [],
            getClient: () => ({
                async *iterMessages() {
                    yield* messages;
                },
            }),
            isQuickDocument: () => false,
            locate: () => ({ size: 1, mimeType: "application/octet-stream" }),
            createFolder: () => ({ id: "folder" }),
            createFile: (record) => {
                added.push(record.name);
                return { id: record.name };
            },
            update() {},
            flush: async () => {},
        },
    );
    const result = await importFromTelegram();
    assert.equal(result.added, 3);
    assert.deepEqual(added, names.slice(3));
});

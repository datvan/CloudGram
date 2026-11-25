import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { File } from "node:buffer";
import {
    encryptJson,
    decryptJson,
    fromBase64,
    toBase64,
} from "../../src/services/crypto.js";

async function load(path, globals, names) {
    const source = (await readFile(new URL(path, import.meta.url), "utf8"))
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    return vm.runInNewContext(`${source}\n;({${names.join(",")}})`, {
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        File,
        console,
        setTimeout,
        clearTimeout,
        ...globals,
    });
}

async function vaultFor(key) {
    const account = await load(
        "../../src/services/account.js",
        {
            api: {
                prelogin: async () => ({ kdf: {} }),
                login: async () => ({}),
                me: async () => ({}),
                lease: async () => ({ status: "busy" }),
            },
            Store: { dispatch() {} },
            setAuth: (x) => x,
            deriveKeys: async () => ({}),
            unwrapDek: async () => key,
            clearKey: async () => {},
            openDrive: async () => {},
            openUploadLog() {},
            getSnapshot: () => ({ dirty: false }),
            localStorage: { getItem: () => "done" },
            browserId: () => "browser",
            setInterval: () => 1,
            clearInterval() {},
            encryptJson,
            decryptJson,
        },
        ["login", "treeBackupCrypto"],
    );
    await account.login("user", "password", false);
    return account.treeBackupCrypto;
}

test("encrypted backups are account-scoped, restorable, and retention preserves other files", async () => {
    const key = () =>
        webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
        ]);
    const getVault = await vaultFor(await key());
    const otherVault = await vaultFor(await key());
    const vault = await getVault();
    assert.equal((await getVault()).tag, vault.tag);
    assert.notEqual((await otherVault()).tag, vault.tag);
    class Filename {
        constructor(fileName) {
            this.fileName = fileName;
        }
    }
    const message = (id, name) => ({
        id,
        date: id,
        media: { document: { attributes: [new Filename(name)] } },
    });
    const messages = Array.from({ length: 11 }, (_, i) =>
        message(100 + i, `cgb-${vault.tag}-${i}.bin`),
    );
    messages.push(
        message(200, `cgb-${(await otherVault()).tag}-other.bin`),
        message(201, "cloudgram-cay-thu-muc-old.json"),
    );
    let sent, deleted, restored, downloaded;
    const client = {
        getMessages: async (_, { search }) =>
            messages.filter((m) =>
                m.media.document.attributes[0].fileName.includes(search),
            ),
        sendFile: async (_, options) => {
            sent = options;
        },
        deleteMessages: async (_, ids) => {
            deleted = ids;
        },
    };
    const backup = await load(
        "../../src/services/treeBackup.js",
        {
            Api: {
                DocumentAttributeFilename: Filename,
                InputMessagesFilterDocument: class {},
            },
            treeBackupCrypto: getVault,
            encryptJson,
            decryptJson,
            fromBase64,
            toBase64,
            getClient: () => client,
            isOnline: () => true,
            getSnapshot: () => ({
                records: [{ name: "secret-name.txt", enc: "secret-key" }],
                labels: [],
            }),
            uploadParts: async (_, file) => file,
            localStorage: { getItem: () => null, setItem() {} },
            fetchFile: async () => downloaded,
            restoreRecords: (records) => {
                restored = records;
                return records.length;
            },
            flush: async () => {},
        },
        ["backupNow", "listBackups", "restoreBackup"],
    );
    await backup.backupNow();
    assert.match(sent.file.name, new RegExp(`^cgb-${vault.tag}-.*\\.bin$`));
    assert.equal(sent.file.type, "application/octet-stream");
    assert.equal("caption" in sent, false);
    const bytes = Buffer.from(await sent.file.arrayBuffer());
    assert.throws(() => JSON.parse(bytes.toString()));
    assert.doesNotMatch(bytes.toString(), /secret-name|secret-key|"enc"/);
    downloaded = sent.file;
    assert.equal(await backup.restoreBackup(1), 1);
    assert.equal(restored[0].name, "secret-name.txt");
    assert.equal(restored[0].enc, "secret-key");
    assert.deepEqual(Array.from(deleted), [100]);
    const listed = await backup.listBackups();
    assert.equal(listed.filter((b) => b.legacy).length, 1);
    assert.equal(
        listed.some((b) => b.id === 200),
        false,
    );
    downloaded = new Blob([
        JSON.stringify({ app: "cloudgram", records: [{ name: "legacy" }] }),
    ]);
    assert.equal(await backup.restoreBackup(201), 1);
    assert.equal(restored[0].name, "legacy");
});

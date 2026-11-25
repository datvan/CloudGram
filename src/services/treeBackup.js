/** Encrypted account-scoped tree backups and Saved Messages import. */
import { Api } from "telegram";

import { treeBackupCrypto } from "./account";
import { fromBase64, toBase64 } from "./crypto";
import { getClient, isOnline } from "./telegram";
import { isQuickDocument } from "./quickKey";
import {
    createFile,
    createFolder,
    flush,
    getSnapshot,
    restoreRecords,
    update,
} from "./drive";
import { fetchFile, locate } from "../utils/downloadFile";
import { messagesOf } from "../utils/splitPlan";
import { uploadParts } from "../utils/transfer";

export const BACKUP_PREFIX = "cloudgram-cay-thu-muc-";
const EVERY = 30 * 60 * 1000;
const FIRST = 60 * 1000;
const KEEP = 10;
const LAST_HASH = "cloudgram.treeBackupHash";

let timer = null;
let running = null;

async function hashOf(text) {
    const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text),
    );
    return Array.from(new Uint8Array(bytes), (b) =>
        b.toString(16).padStart(2, "0"),
    ).join("");
}

const stamp = (date) =>
    date.toISOString().slice(0, 16).replace("T", "-").replace(":", "");

function nameOf(message) {
    const attrs = message.media?.document?.attributes ?? [];
    const named = attrs.find((a) => a instanceof Api.DocumentAttributeFilename);
    return named?.fileName ?? null;
}

/** Backups in Saved Messages, newest first: [{ id, name, date, size }]. */
export async function listBackups() {
    const { tag } = await treeBackupCrypto();
    const prefix = `cgb-${tag}-`;
    const found = (
        await Promise.all(
            [prefix, BACKUP_PREFIX].map((search) =>
                getClient().getMessages("me", {
                    search,
                    filter: new Api.InputMessagesFilterDocument(),
                    limit: 50,
                }),
            ),
        )
    ).flat();
    return found
        .map((m) => ({
            id: m.id,
            name: nameOf(m),
            date: new Date(m.date * 1000),
            size: Number(m.media?.document?.size ?? 0),
        }))
        .filter((b) => {
            b.legacy = Boolean(
                b.name?.startsWith(BACKUP_PREFIX) && b.name.endsWith(".json"),
            );
            return (
                b.legacy ||
                (b.name?.startsWith(prefix) && b.name.endsWith(".bin"))
            );
        })
        .sort((a, b) => b.date - a.date);
}

/** Send a copy now if the tree changed since the last one; true if sent. */
export function backupNow({ force = false } = {}) {
    running ??= (async () => {
        const { records: files, labels } = getSnapshot();
        if (!files.length || !isOnline()) return false;
        // labels are records too, kept apart in the snapshot
        const records = [...files, ...labels];
        const body = JSON.stringify(records);
        const vault = await treeBackupCrypto();
        const hash = await hashOf(body);
        const hashKey = `${LAST_HASH}.${vault.tag}`;
        let last = null;
        try {
            last = localStorage.getItem(hashKey);
        } catch {
            // storage blocked: send every time, which is only wasteful
        }
        if (!force && last === hash) return false;
        const now = new Date();
        const encrypted = await vault.encrypt({
            app: "cloudgram",
            kind: "tree-backup",
            version: 1,
            savedAt: now.toISOString(),
            records,
        });
        const file = new File(
            [
                new TextEncoder().encode("CGB1"),
                fromBase64(encrypted.iv),
                fromBase64(encrypted.ct),
            ],
            `cgb-${vault.tag}-${stamp(now)}.bin`,
            {
                type: "application/octet-stream",
            },
        );
        const client = getClient();
        await client.sendFile("me", {
            file: await uploadParts(client, file),
            forceDocument: true,
        });
        try {
            localStorage.setItem(hashKey, hash);
        } catch {
            // see above
        }
        const old = (await listBackups())
            .filter((b) => !b.legacy)
            .slice(KEEP)
            .map((b) => b.id);
        if (old.length)
            await client.deleteMessages("me", old, { revoke: true });
        return true;
    })().finally(() => {
        running = null;
    });
    return running;
}

export function startTreeBackup() {
    stopTreeBackup();
    const run = () =>
        backupNow().catch((error) => console.log("Tree backup failed:", error));
    timer = setTimeout(function tick() {
        run();
        timer = setTimeout(tick, EVERY);
    }, FIRST);
}

export function stopTreeBackup() {
    clearTimeout(timer);
    timer = null;
}

/** Read backup message `id` and put back what is missing; returns a count. */
export async function restoreBackup(id) {
    const blob = await fetchFile("tree-backup", id, { quiet: true });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const data =
        new TextDecoder().decode(bytes.slice(0, 4)) === "CGB1"
            ? await (
                  await treeBackupCrypto()
              ).decrypt({
                  iv: toBase64(bytes.slice(4, 16)),
                  ct: toBase64(bytes.slice(16)),
              })
            : JSON.parse(new TextDecoder().decode(bytes));
    if (data?.app !== "cloudgram" || !Array.isArray(data.records))
        throw new Error("File này không phải bản sao cây thư mục CloudGram.");
    const count = restoreRecords(data.records);
    await flush();
    return count;
}

function guessName(message, file) {
    const named = nameOf(message);
    if (named) return named;
    const day = new Date(message.date * 1000).toISOString().slice(0, 10);
    const ext = (file.mimeType ?? "")
        .split("/")[1]
        ?.replace("quicktime", "mov");
    return `telegram-${day}-${message.id}${ext ? `.${ext}` : ""}`;
}

/**
 * Add every file in Saved Messages that no record points at, into a folder
 * "Nhập từ Telegram". Skips this app's own storyboards and tree backups.
 * `onProgress(scanned, added)` is called as it goes.
 */
export async function importFromTelegram(onProgress) {
    const known = new Set(getSnapshot().records.flatMap(messagesOf));
    for (const r of getSnapshot().records)
        if (r.storyboard) known.add(r.storyboard.message);
    let folder = null;
    let scanned = 0;
    let added = 0;
    for await (const message of getClient().iterMessages("me", {
        reverse: true,
    })) {
        scanned += 1;
        if (scanned % 200 === 0) onProgress?.(scanned, added);
        if (!message.media || known.has(message.id)) continue;
        const name = nameOf(message);
        if (
            name === "storyboard.jpg" ||
            name === "cloudgram-storyboard-v1.bin" ||
            name === "cloudgram-thumbnail-v1.bin" ||
            name?.startsWith(BACKUP_PREFIX) ||
            /^cgb-[0-9a-f]{16}-.*\.bin$/.test(name ?? "") ||
            isQuickDocument(message)
        )
            continue;
        const file = locate(message.media);
        if (!file) continue;
        folder ??= createFolder("Nhập từ Telegram", null);
        const record = createFile({
            name: guessName(message, file),
            parent: folder.id,
            size: file.size,
            mime: file.mimeType,
            createdAt: message.date * 1000,
        });
        update(record.id, { file_id: message.id });
        added += 1;
    }
    onProgress?.(scanned, added);
    await flush();
    return { scanned, added };
}

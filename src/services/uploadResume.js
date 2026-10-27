/**
 * Picking up the uploads a closed tab left behind (see uploadLog.js).
 *
 * What is found falls in four groups, by where the bytes can come from again:
 *
 * - sent already: the message is in Saved Messages but the vault never got its
 *   id. It is attached, not sent again.
 * - Dropbox: the link is run again; files that made it are skipped by name and
 *   size, and the rest fill their old records (dropboxImport.js).
 * - a saved file handle (Chrome, Edge): read again after one permission prompt.
 * - anything else: the user picks the files or folder again and they are
 *   matched to the records by name, size and folder.
 *
 * A record left without a file_id and without a log entry (from before the
 * log existed, or from another browser) can only come back the last way.
 */
import { getClient } from "./telegram";
import {
    createFile,
    createFolder,
    getRecord,
    getSnapshot,
    removeRecords,
    wasDeleted,
} from "./drive";
import { startImport } from "./dropboxImport";
import {
    TAB,
    claim,
    dropEntry,
    exclusively,
    liveTabs,
    readEntries,
} from "./uploadLog";
import { isHidden, pathTo } from "../utils/tree";
import { fileOpener } from "../utils/pickers";
import {
    adoptMessage,
    enqueueUpload,
    hasJob,
    isQueued,
} from "../utils/uploadQueue";

const lastName = (path) => path.split("/").filter(Boolean).pop() ?? "";

/**
 * What a closed tab left: `files` (one per record, each with its log `entry`
 * when there is one) and `imports` (Dropbox links still being read).
 */
export async function scan() {
    const entries = await readEntries();
    const live = await liveTabs();
    const logged = new Set(entries.map((e) => e.id));
    const files = [];
    const imports = [];

    for (const entry of entries) {
        // this tab's own count too once nothing here holds them any more:
        // claimed by "Tiếp tục" but not readable yet, or needing a pick.
        // A link it is reading is still its own.
        if (
            entry.tab === TAB
                ? entry.kind === "import" || hasJob(entry.id)
                : live.has(entry.tab)
        )
            continue;
        if (entry.kind === "import") {
            imports.push(entry);
            continue;
        }
        const record = getRecord(entry.id);
        // deleted since, or finished after all: nothing left to do
        if (wasDeleted(entry.id) || record?.file_id != null) {
            dropEntry(entry.id);
            continue;
        }
        if (isQueued(entry.id)) continue;
        files.push({
            id: entry.id,
            entry,
            name: record?.name ?? entry.record.name,
            size: record?.size ?? entry.record.size,
        });
    }

    const { records, byId } = getSnapshot();
    for (const record of records) {
        if (
            record.type !== "file" ||
            record.file_id != null ||
            logged.has(record.id) ||
            isQueued(record.id) ||
            isHidden(byId, record)
        )
            continue;
        files.push({ id: record.id, name: record.name, size: record.size });
    }

    return { files, imports };
}

/** Roots to ask read access for, one per pick, before anything is awaited. */
export function handleRoots({ files }) {
    const roots = new Map();
    for (const { entry } of files) {
        const handle = entry?.handle;
        if (handle && entry.source?.dropbox == null)
            roots.set(handle.rootId, handle.root);
    }
    return [...roots.values()];
}

/**
 * Put a record back that the vault never received, under its old id, along
 * with any folder above it that never got there either.
 */
function ensureRecord({ id, entry }) {
    if (getRecord(id)) return true;
    if (!entry || wasDeleted(id)) return false;
    // root first, so each folder's parent is in place before it
    let parent = null;
    for (const folder of entry.folders ?? []) {
        if (getRecord(folder.id)) {
            parent = folder.id;
            continue;
        }
        // thrown away since: what was going into it lands higher up
        if (wasDeleted(folder.id)) continue;
        createFolder(folder.name, parent, folder);
        parent = folder.id;
    }
    if (!entry.folders) parent = entry.record.parent;
    const { byId } = getSnapshot();
    // the folder it was going into is gone; land at the root, like restore()
    if (parent && (!getRecord(parent) || isHidden(byId, getRecord(parent))))
        parent = null;
    createFile({ id, ...entry.record, parent });
    return true;
}

/**
 * The message an earlier tab sent for this entry, if it got that far: by the
 * id it noted, or else by looking through Saved Messages around the time it
 * started sending.
 */
async function sentMessage(entry) {
    const client = getClient();
    if (entry.messageId) {
        const [message] = await client.getMessages("me", {
            ids: [entry.messageId],
        });
        if (message) return message;
    }
    if (!entry.sending) return null;
    const startedAt = entry.sending / 1000;
    const messages = await client.getMessages("me", {
        limit: 100,
        offsetDate: Math.ceil(startedAt) + 600,
    });
    const used = new Set(
        getSnapshot()
            .records.map((r) => r.file_id)
            .filter((x) => x != null),
    );
    const fits = (m) => {
        if (used.has(m.id) || m.date < startedAt - 5) return false;
        if (entry.sentAs === "photo") return Boolean(m.media?.photo);
        const doc = m.media?.document;
        if (!doc || Number(doc.size) !== entry.record.size) return false;
        return doc.attributes?.some((a) => a.fileName === entry.record.name);
    };
    const near = (m) => Math.abs(m.date - startedAt);
    return messages.filter(fits).sort((a, b) => near(a) - near(b))[0] ?? null;
}

// files opened from their handles at once; each is a few small disk reads
const OPEN_AT_ONCE = 32;
// opened files are queued in groups this big: queueing one at a time renders
// the transfer list once per file, which slows to a crawl in the thousands
const QUEUE_EVERY = 200;

/**
 * Resume everything that can go without the user picking files. `granted` is
 * the promise askToRead() returned, started inside the click.
 * `onProgress({ done, total })` hears how many files were looked at so far.
 *
 * Resolves to how it went, with `needsPick`: the files that still need to be
 * picked again, and `denied`: those the browser would not let be read yet,
 * which another click on "Tiếp tục" asks for again.
 */
export async function resume(found, granted, onProgress) {
    const result = {
        adopted: 0,
        queued: 0,
        links: 0,
        needsPick: [],
        denied: [],
    };

    // claimed under a lock: two tabs reopened at once must not both take them
    const mine = await exclusively(async () => {
        const live = await liveTabs();
        const now = new Map((await readEntries()).map((e) => [e.id, e]));
        // still left behind: its entry is there and no other open tab owns
        // it (this one does when "Tiếp tục" is clicked a second time)
        const still = (logged) => {
            const entry = now.get(logged.id);
            return (
                Boolean(entry) && (entry.tab === TAB || !live.has(entry.tab))
            );
        };
        const files = found.files.filter(
            (item) => !item.entry || still(item.entry),
        );
        const imports = found.imports.filter(still);
        claim([...files.map((item) => item.entry).filter(Boolean), ...imports]);
        return { files, imports };
    });

    // each entry's handle is its own copy out of IndexedDB, so the answer is
    // asked of every root again; a granted one now just says yes
    await granted;
    const allowed = new Map();
    const canRead = (handle) => {
        if (!allowed.has(handle.rootId))
            allowed.set(
                handle.rootId,
                handle.root.queryPermission({ mode: "read" }).then(
                    (answer) => answer === "granted",
                    () => false,
                ),
            );
        return allowed.get(handle.rootId);
    };
    const links = new Map();
    for (const entry of mine.imports) {
        links.set(`${entry.parentID}\n${entry.link}`, entry);
        dropEntry(entry.id);
    }

    const total = mine.files.length;
    let done = 0;
    let told = 0;
    const tell = (force) => {
        const now = performance.now();
        if (!force && now - told < 100) return;
        told = now;
        onProgress?.({ done, total });
    };

    // what can be read from a saved handle; opened together further down
    const toOpen = [];
    for (const item of mine.files) {
        const { id, entry } = item;
        if (!ensureRecord(item)) {
            dropEntry(id);
            done += 1;
            continue;
        }
        if (entry?.messageId || entry?.sending) {
            try {
                const message = await sentMessage(entry);
                if (message) {
                    await adoptMessage(
                        id,
                        message,
                        entry.sentAs,
                        entry.replaces,
                    );
                    result.adopted += 1;
                    done += 1;
                    continue;
                }
            } catch (error) {
                // cannot tell whether it was sent; let the user decide
                console.log(error);
                result.needsPick.push(item);
                done += 1;
                continue;
            }
        }
        const dropbox = entry?.source?.dropbox;
        if (dropbox) {
            const parent = entry.source.parent ?? null;
            links.set(`${parent}\n${dropbox}`, {
                link: dropbox,
                parentID: parent,
                asMedia: entry.asMedia,
            });
            done += 1;
            continue;
        }
        if (entry?.handle) toOpen.push(item);
        else {
            result.needsPick.push(item);
            done += 1;
        }
    }
    tell(true);

    const open = fileOpener();
    let ready = [];
    const queueReady = () => {
        for (const [item, file, unchanged] of ready)
            queue(item, file, item.entry.handle, item.entry.path, unchanged);
        result.queued += ready.length;
        ready = [];
    };
    let next = 0;
    const lane = async () => {
        while (next < toOpen.length) {
            const item = toOpen[next];
            next += 1;
            const { handle } = item.entry;
            try {
                if (!(await canRead(handle))) result.denied.push(item);
                else {
                    const file = await open(handle);
                    if (file.size === getRecord(item.id)?.size) {
                        // touched since (a photo app, a sync client) but the
                        // same size: sent again whole, without asking
                        ready.push([item, file, sameBytes(item, file)]);
                        if (ready.length >= QUEUE_EVERY) queueReady();
                    } else result.needsPick.push(item);
                }
            } catch (error) {
                // moved or deleted since; picking it again may still work
                console.log(error);
                result.needsPick.push(item);
            }
            done += 1;
            tell(false);
        }
    };
    await Promise.all(Array.from({ length: OPEN_AT_ONCE }, lane));
    queueReady();
    tell(true);

    for (const { link, parentID, asMedia } of links.values()) {
        startImport([link], parentID, { asMedia });
        result.links += 1;
    }
    return result;
}

/** Same size, and the same modification time when the log knows it. */
function sameBytes(item, file) {
    const known = item.entry?.lastModified;
    return (
        file.size === getRecord(item.id)?.size &&
        (known == null || known === file.lastModified)
    );
}

function queue(item, file, handle, path, unchanged) {
    const record = getRecord(item.id);
    enqueueUpload({
        file,
        recordId: item.id,
        asMedia: item.entry?.asMedia ?? false,
        // parts sent last time only count for the very same file
        resume: unchanged ? item.entry?.resume : undefined,
        handle,
        path: path ?? record.name,
        replaces: item.entry?.replaces,
    });
}

/**
 * Match files the user picked again against the records still waiting.
 * Name and size decide; when several records share both, the one whose
 * folders end like the picked path wins. Returns what is still unmatched.
 */
export function matchPicked(waiting, picked) {
    const { byId } = getSnapshot();
    // by name and size: thousands picked against thousands waiting
    const pool = new Map();
    const keyOf = (name, size) => `${size}
${name}`;
    for (const item of waiting) {
        if (!getRecord(item.id)) continue;
        const key = keyOf(item.name, item.size);
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key).push(item);
    }
    let queued = 0;
    for (const { file, path, handle } of picked) {
        const name = lastName(path ?? file.name);
        const dirs = (path ?? "").split("/").filter(Boolean).slice(0, -1);
        const candidates = pool.get(keyOf(name, file.size));
        if (!candidates?.length) continue;
        const score = (item) => {
            const folders = pathTo(byId, getRecord(item.id).parent).map(
                (f) => f.name,
            );
            let same = 0;
            while (
                same < dirs.length &&
                same < folders.length &&
                dirs[dirs.length - 1 - same] ===
                    folders[folders.length - 1 - same]
            )
                same += 1;
            return same;
        };
        candidates.sort((a, b) => score(b) - score(a));
        const best = candidates.shift();
        queue(best, file, handle, path, sameBytes(best, file));
        queued += 1;
    }
    return { queued, unmatched: [...pool.values()].flat() };
}

/**
 * Give up on what was left: the half-made records go, along with any
 * message a closed tab sent for them that never reached the vault.
 */
export async function discard(found) {
    const messages = found.files
        .map((item) => item.entry?.messageId)
        .filter((id) => id != null);
    if (messages.length) {
        await getClient().deleteMessages("me", messages, { revoke: true });
    }
    const ids = found.files
        .map((item) => item.id)
        .filter((id) => getRecord(id));
    for (const item of [...found.files, ...found.imports]) dropEntry(item.id);
    if (ids.length) await removeRecords(ids);
}

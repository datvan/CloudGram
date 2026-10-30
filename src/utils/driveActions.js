/**
 * Operations that touch both Telegram and the tree, kept out of the views so
 * the ordering rules live in one place:
 *
 * - Telegram first, then the records. If Telegram throws, the tree is intact
 *   and the delete can be retried; the other order would leave files in Saved
 *   Messages that nothing points at any more.
 * - Trash is a soft delete. Only "delete forever" touches Telegram.
 */
import { buildTreeFromPaths } from "./buildTreeFromPaths";
import downloadFile from "./downloadFile";
import { entriesOf, isAbort } from "./pickers";
import { collectSubtree, findFolder, messageIdsOf, recordIdsOf } from "./tree";
import { cancelUploads, enqueueUpload, isQueued } from "./uploadQueue";
import { createFolder, getSnapshot, removeRecords } from "../services/drive";
import { TAB, liveTabs, readEntries } from "../services/uploadLog";
import { dropShares } from "../services/shares";
import { getClient } from "../services/telegram";

/**
 * Upload loose files, or a picked/dropped folder, under `parentID`.
 *
 * Folders of the same name merge. For files:
 *
 * - one still unfinished in the target folder under the same name and size
 *   (a closed tab, a failure) is uploaded into its old record, from the
 *   parts Telegram already has when the bytes are unchanged. Nothing is
 *   asked: it is the same upload, interrupted.
 * - one whose name is taken by a finished file is a conflict, as when
 *   copying in a file manager. `onConflict(conflicts)` decides for all of
 *   them at once and resolves to "replace" (the old file goes to the trash
 *   once the new one is up), "keep" (the new one is renamed "name (1).ext"),
 *   "skip", or "cancel", which uploads nothing at all. Without it they are
 *   skipped.
 *
 * Resolves to how many files were `queued`, `resumed`, `replaced`,
 * `renamed` and `skipped`.
 */
export async function uploadEntries(
    entries,
    parentID,
    { asMedia = false, removeOriginal = false, onConflict } = {},
) {
    const tree = buildTreeFromPaths(entries);
    const records = getSnapshot().records;
    const realId = new Map();
    const parentOf = (item) =>
        item.parentTempId ? realId.get(item.parentTempId) : parentID;

    // Uploading the same folder twice merges into the existing one. Folders
    // still missing are only made once the conflicts are settled, so a
    // cancelled upload leaves nothing behind; nothing in them can conflict.
    // buildTreeFromPaths lists parents before children.
    const missing = [];
    for (const folder of tree.folders) {
        const parent = parentOf(folder);
        const existing =
            parent !== MISSING && findFolder(records, parent, folder.name);
        realId.set(folder.tempId, existing ? existing.id : MISSING);
        if (!existing) missing.push(folder);
    }

    // what each folder already holds, by name
    const named = new Map();
    for (const record of records) {
        if (record.trashedAt) continue;
        const key = nameKey(record.parent, record.name);
        if (!named.has(key)) named.set(key, []);
        named.get(key).push(record);
    }

    const placed = tree.files.map((entry) => {
        const parent = parentOf(entry);
        const name = entry.name ?? entry.file.name;
        const there =
            parent === MISSING ? [] : named.get(nameKey(parent, name)) ?? [];
        const files = there.filter((r) => r.type === "file");
        return {
            entry,
            parent,
            name,
            unfinished: files.find(
                (r) => r.file_id == null && r.size === entry.file.size,
            ),
            taken: files.find((r) => r.file_id != null),
        };
    });

    // unfinished matches may have a log entry: the parts already sent, and
    // whether another open tab is uploading the file right now
    let logOf = new Map();
    let live = new Set();
    if (placed.some((p) => p.unfinished)) {
        [logOf, live] = await Promise.all([
            readEntries().then((all) => new Map(all.map((e) => [e.id, e]))),
            liveTabs(),
        ]);
    }

    const conflicts = placed.filter((p) => !p.unfinished && p.taken);
    const choice = conflicts.length
        ? (await onConflict?.(
              conflicts.map((p) => ({
                  name: p.name,
                  size: p.entry.file.size,
                  existingSize: p.taken.size,
              })),
          )) ?? "skip"
        : null;

    const counts = {
        queued: 0,
        resumed: 0,
        replaced: 0,
        renamed: 0,
        skipped: 0,
    };
    if (choice === "cancel") return counts;

    for (const folder of missing) {
        const record = createFolder(folder.name, parentOf(folder));
        realId.set(folder.tempId, record.id);
    }
    const queue = (p, extra = {}) =>
        enqueueUpload({
            file: p.entry.file,
            name: p.name,
            handle: p.entry.handle,
            path: p.entry.path,
            asMedia,
            removeOriginal,
            parentID: parentOf(p.entry),
            ...extra,
        });

    for (const p of placed) {
        const { entry, unfinished, taken } = p;
        if (unfinished) {
            const log = logOf.get(unfinished.id);
            if (
                isQueued(unfinished.id) ||
                (log && log.tab !== TAB && live.has(log.tab)) ||
                // its message may be out already; the resume banner looks
                // for it in Saved Messages instead of sending a second copy
                log?.messageId ||
                log?.sending
            ) {
                counts.skipped += 1;
                continue;
            }
            const unchanged =
                log?.lastModified == null ||
                log.lastModified === entry.file.lastModified;
            enqueueUpload({
                file: entry.file,
                recordId: unfinished.id,
                handle: entry.handle,
                path: entry.path,
                asMedia: log?.asMedia ?? asMedia,
                resume: unchanged ? log?.resume : undefined,
                replaces: log?.replaces,
                // picked again just now, so what was chosen just now
                removeOriginal,
            });
            counts.resumed += 1;
        } else if (!taken) {
            queue(p);
            counts.queued += 1;
        } else if (choice === "replace") {
            queue(p, { replaces: taken.id });
            counts.replaced += 1;
        } else if (choice === "keep") {
            const name = freeName(named, p.parent, p.name);
            // taken from now on, for the next file of this batch
            named.set(nameKey(p.parent, name), [{ name }]);
            queue(p, { name });
            counts.renamed += 1;
        } else {
            counts.skipped += 1;
        }
    }
    return counts;
}

// the parent of what goes into a folder not made yet
const MISSING = Symbol("missing folder");

const nameKey = (parent, name) => `${parent ?? ""}\n${name}`;

/** "name (1).ext", "name (2).ext"... whichever is free in the folder. */
function freeName(named, parent, name) {
    const dot = name.lastIndexOf(".");
    const [stem, ext] =
        dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n += 1) {
        const candidate = `${stem} (${n})${ext}`;
        if (!named.has(nameKey(parent, candidate))) return candidate;
    }
}

/**
 * Walk a drop's DataTransfer into `{ file, path }` pairs, folders included.
 * Must be called synchronously inside the drop handler: the items list is
 * emptied once the event returns, so the entries are grabbed up front.
 */
export async function readDrop(dataTransfer, scan) {
    const items = Array.from(dataTransfer.items ?? []).filter(
        (item) => item.kind === "file",
    );
    // Chrome and Edge hand out file handles too, which is what lets a closed
    // tab resume without the files being dropped again (pickers.js)
    const handles = items.map((item) => item.getAsFileSystemHandle?.());
    const roots = [];
    for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) roots.push(entry);
    }
    const loose = Array.from(dataTransfer.files ?? []);
    if (items.length && handles.every(Boolean)) {
        try {
            const resolved = await Promise.all(handles);
            if (resolved.every(Boolean)) {
                const lists = await Promise.all(
                    resolved.map((handle) => entriesOf(handle, scan)),
                );
                scan?.done();
                return lists.flat();
            }
        } catch (error) {
            // what was found so far may be uploading already; walking it all
            // again the other way would queue it twice
            if (isAbort(error) || scan?.handed) throw error;
            // fall back to the entries grabbed above
            scan?.restart();
        }
    }
    if (!roots.length) {
        const entries = loose.map((file) => ({ file, path: file.name }));
        entries.forEach((entry) => {
            scan?.add(entry.file);
            scan?.found(entry);
        });
        scan?.done();
        return entries;
    }
    const lists = await Promise.all(
        roots.map((entry) => walk(entry, "", scan)),
    );
    scan?.done();
    return lists.flat();
}

async function walk(entry, prefix, scan) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
        const file = await new Promise((resolve, reject) =>
            entry.file(resolve, reject),
        );
        scan?.add(file);
        scan?.found({ file, path });
        return [{ file, path }];
    }
    const reader = entry.createReader();
    const children = [];
    // readEntries hands back at most ~100 at a time; keep going until empty
    for (;;) {
        const batch = await new Promise((resolve, reject) =>
            reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        children.push(...batch);
    }
    scan?.check();
    const lists = await Promise.all(
        children.map((child) => walk(child, path, scan)),
    );
    return lists.flat();
}

// files fetched at once; they share one pool of parts in flight
// (transfer.js), so more at once only spreads it thinner
const DOWNLOADS_AT_ONCE = 3;

export async function downloadMany(records) {
    const files = records.filter(
        (record) => record.type === "file" && record.file_id != null,
    );
    let next = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(DOWNLOADS_AT_ONCE, files.length) },
            async () => {
                while (next < files.length) {
                    const record = files[next++];
                    await downloadFile(record.id, record.file_id, record.name);
                }
            },
        ),
    );
}

// collectSubtree treats its root as a folder, so a file is its own subtree
function subtreeOf(records, id) {
    const self = records.find((r) => r.id === id);
    if (!self) return { folders: [], files: [] };
    if (self.type === "file") return { folders: [], files: [self] };
    return collectSubtree(records, id);
}

/** Everything that would go if these were deleted forever. */
export function countForever(ids) {
    const { records } = getSnapshot();
    let folders = 0;
    let files = 0;
    for (const id of ids) {
        const subtree = subtreeOf(records, id);
        folders += subtree.folders.length;
        files += subtree.files.length;
    }
    return { folders, files };
}

export async function deleteForever(ids) {
    const { records } = getSnapshot();
    const recordIds = new Set();
    const messageIds = new Set();
    for (const id of ids) {
        // Counted again rather than reusing the dialog's snapshot: a folder
        // upload may have added records to this subtree meanwhile.
        const subtree = subtreeOf(records, id);
        recordIdsOf(subtree).forEach((x) => recordIds.add(x));
        messageIdsOf(subtree).forEach((x) => messageIds.add(x));
    }

    cancelUploads([...recordIds]);
    // a file deleted for good must not stay downloadable through its link
    await dropShares(records.filter((r) => recordIds.has(r.id)));
    if (messageIds.size) {
        await getClient().deleteMessages("me", [...messageIds], {
            revoke: true,
        });
    }
    await removeRecords([...recordIds]);
}

export function emptyTrash() {
    const trashed = getSnapshot().records.filter((r) => r.trashedAt);
    return deleteForever(trashed.map((r) => r.id));
}

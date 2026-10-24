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
import { collectSubtree, findFolder, messageIdsOf, recordIdsOf } from "./tree";
import { cancelUploads, enqueueUpload } from "./uploadQueue";
import { createFolder, getSnapshot, removeRecords } from "../services/drive";
import { getClient } from "../services/telegram";

/** Upload loose files, or a picked/dropped folder, under `parentID`. */
export function uploadEntries(entries, parentID, { asMedia = false } = {}) {
    const tree = buildTreeFromPaths(entries);
    const records = [...getSnapshot().records];
    const realId = new Map();

    // buildTreeFromPaths lists parents before children, so every parent
    // already has a real id by the time its child is reached.
    for (const folder of tree.folders) {
        const parent = folder.parentTempId
            ? realId.get(folder.parentTempId)
            : parentID;
        // uploading the same folder twice merges into the existing one
        const existing = findFolder(records, parent, folder.name);
        if (existing) {
            realId.set(folder.tempId, existing.id);
            continue;
        }
        const record = createFolder(folder.name, parent);
        // keep the snapshot current so the next sibling dedupes too
        records.push(record);
        realId.set(folder.tempId, record.id);
    }

    for (const entry of tree.files) {
        enqueueUpload({
            file: entry.file,
            name: entry.name,
            asMedia,
            parentID: entry.parentTempId
                ? realId.get(entry.parentTempId)
                : parentID,
        });
    }
    return tree.files.length;
}

/**
 * Walk a drop's DataTransfer into `{ file, path }` pairs, folders included.
 * Must be called synchronously inside the drop handler: the items list is
 * emptied once the event returns, so the entries are grabbed up front.
 */
export function readDrop(dataTransfer) {
    const roots = [];
    for (const item of Array.from(dataTransfer.items ?? [])) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) roots.push(entry);
    }
    if (!roots.length) {
        return Promise.resolve(
            Array.from(dataTransfer.files ?? []).map((file) => ({
                file,
                path: file.name,
            })),
        );
    }
    return Promise.all(roots.map((entry) => walk(entry, ""))).then((lists) =>
        lists.flat(),
    );
}

async function walk(entry, prefix) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
        const file = await new Promise((resolve, reject) =>
            entry.file(resolve, reject),
        );
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
    const lists = await Promise.all(children.map((child) => walk(child, path)));
    return lists.flat();
}

export async function downloadMany(records) {
    // one at a time: each download is held in memory until it is saved
    for (const record of records) {
        if (record.type === "file" && record.file_id != null) {
            await downloadFile(record.id, record.file_id, record.name);
        }
    }
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

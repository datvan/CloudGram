/**
 * Pure helpers over the flat record list of the file tree (services/drive.js).
 *
 * Records imported from the old IndexedDB tree may carry no `parent` key at
 * all, so undefined and null both mean "at the root" throughout.
 */

const parentOf = (record) => record.parent ?? undefined;

export function childrenOf(records, parentId) {
    const parent = parentId ?? undefined;
    return records.filter((record) => parentOf(record) === parent);
}

export function findFolder(records, parentId, name) {
    const parent = parentId ?? undefined;
    return records.find(
        (record) =>
            record.type === "folder" &&
            !record.trashedAt &&
            record.name === name &&
            parentOf(record) === parent,
    );
}

/** Folders from the root down to `id`, for breadcrumbs. */
export function pathTo(byId, id) {
    const path = [];
    const seen = new Set();
    let cursor = id ? byId.get(id) : undefined;
    while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        path.unshift(cursor);
        cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
    return path;
}

/** Trashed itself, or sitting somewhere under a trashed folder. */
export function isHidden(byId, record) {
    const seen = new Set();
    let cursor = record;
    while (cursor && !seen.has(cursor.id)) {
        if (cursor.trashedAt) return true;
        seen.add(cursor.id);
        cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
    return false;
}

/**
 * Walk a folder and everything underneath it.
 *
 * `folders` includes the folder itself so the caller can drop the whole subtree
 * from one list. Files whose upload never finished have no file_id, but they
 * still belong in `files` so their records get cleaned up too.
 */
export function collectSubtree(records, rootId) {
    const byParent = new Map();
    for (const record of records) {
        const parent = parentOf(record);
        if (parent === undefined) continue;
        const siblings = byParent.get(parent);
        if (siblings) siblings.push(record);
        else byParent.set(parent, [record]);
    }

    const root = records.find((record) => record.id === rootId);
    const folders = root ? [root] : [];
    const files = [];
    const seen = new Set([rootId]);
    const queue = [rootId];

    while (queue.length) {
        for (const child of byParent.get(queue.shift()) ?? []) {
            // a record cycle would otherwise hang the tab
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            if (child.type === "folder") {
                folders.push(child);
                queue.push(child.id);
            } else {
                files.push(child);
            }
        }
    }

    return { folders, files };
}

/** Records to drop from the tree, files that never finished uploading included. */
export function recordIdsOf({ folders, files }) {
    return [...folders.map((folder) => folder.id), ...files.map((f) => f.id)];
}

/** Messages to delete from Telegram; a file still uploading has none yet. */
export function messageIdsOf({ files }) {
    return files
        .filter((file) => file.file_id !== undefined && file.file_id !== null)
        .map((file) => file.file_id);
}

/**
 * Pure helpers over the flat record list kept in IndexedDB.
 *
 * react-indexed-db-hook cannot list the children of a folder: its getByIndex()
 * resolves to index.get(), which yields only the first match, and its
 * openCursor() only accepts a key range over the keyPath. So everything here
 * works off a full getAll() snapshot instead of an index.
 *
 * Records sitting at the root carry no `parent` key at all, so undefined and
 * null both mean "at the root" throughout.
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
            record.name === name &&
            parentOf(record) === parent,
    );
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

/** Records to drop from IndexedDB, files that never finished uploading included. */
export function recordIdsOf({ folders, files }) {
    return [...folders.map((folder) => folder.id), ...files.map((f) => f.id)];
}

/** Messages to delete from Telegram; a file still uploading has none yet. */
export function messageIdsOf({ files }) {
    return files
        .filter((file) => file.file_id !== undefined && file.file_id !== null)
        .map((file) => file.file_id);
}

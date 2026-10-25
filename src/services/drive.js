/**
 * The file tree: held in memory, synced to the encrypted vault on the VPS.
 *
 * This replaces the per-device IndexedDB tree. Telegram holds the bytes; this
 * holds the hierarchy, so losing it orphans files that still exist in Saved
 * Messages. Hence the care below about never dropping a write.
 *
 * Record shape:
 *
 *     { id, type: "folder" | "file", name, parent: id | null,
 *       file_id?, size?, mime?, starred?, trashedAt?, createdAt, updatedAt }
 *
 * A deleted record stays behind as a tombstone ({ id, deleted: true,
 * updatedAt }) so a device that has not heard of the delete cannot bring the
 * record back when it merges. Merging is per record, newest updatedAt wins.
 *
 * The server only ever sees the encrypted blob, so it cannot merge; it rejects
 * a write whose base version is stale (409), and the merge happens here.
 */
import { useSyncExternalStore } from "react";
import { v4 as uuid4 } from "uuid";

import { api, ApiError } from "./api";
import { decryptJson, encryptJson } from "./crypto";

const LABEL = "file-tree";
const TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000;
const PUSH_DELAY = 400;

let dek = null;
let version = 0;
let records = new Map();
let snapshot = {
    records: [],
    byId: new Map(),
    syncing: false,
    dirty: false,
    error: null,
};
let dirty = false;
let pushing = null;
let pushTimer = null;
let syncError = null;
const listeners = new Set();

// ----- subscription ----------------------------------------------------------

function publish() {
    const live = [];
    const byId = new Map();
    for (const record of records.values()) {
        if (record.deleted) continue;
        live.push(record);
        byId.set(record.id, record);
    }
    snapshot = {
        records: live,
        byId,
        syncing: Boolean(pushing),
        dirty,
        error: syncError,
    };
    for (const listener of listeners) listener();
}

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** React binding: re-renders whenever the tree or its sync state changes. */
export function useDrive() {
    return useSyncExternalStore(subscribe, () => snapshot);
}

export function getSnapshot() {
    return snapshot;
}

export function getRecord(id) {
    const record = records.get(id);
    return record && !record.deleted ? record : undefined;
}

/** Deleted on purpose (a tombstone), as opposed to never having arrived. */
export function wasDeleted(id) {
    return Boolean(records.get(id)?.deleted);
}

// ----- loading and merging -----------------------------------------------------

function merge(incoming) {
    let changed = false;
    for (const record of incoming) {
        const mine = records.get(record.id);
        if (!mine || (record.updatedAt ?? 0) > (mine.updatedAt ?? 0)) {
            records.set(record.id, record);
            changed = true;
        }
    }
    return changed;
}

async function pull() {
    const blob = await api.getTree();
    if (!blob.version) return { version: 0, records: [] };
    const tree = await decryptJson(dek, blob, LABEL);
    return { version: blob.version, records: tree.records ?? [] };
}

export async function openDrive(key) {
    dek = key;
    records = new Map();
    dirty = false;
    syncError = null;
    const remote = await pull();
    version = remote.version;
    merge(remote.records);
    publish();
}

export function closeDrive() {
    clearTimeout(pushTimer);
    dek = null;
    version = 0;
    records = new Map();
    dirty = false;
    syncError = null;
    publish();
}

/** Pick up what another device wrote, e.g. after taking the lease back. */
export async function refresh() {
    if (!dek) return;
    const remote = await pull();
    if (remote.version !== version) {
        version = remote.version;
        if (merge(remote.records)) publish();
    }
}

/**
 * Fold in records from the old per-device IndexedDB. Ids are UUIDs, so they
 * cannot collide with anything already in the vault.
 */
export function importLegacy(legacy) {
    const now = Date.now();
    const incoming = legacy
        .filter((record) => record?.id && !records.has(record.id))
        .map((record) => ({
            ...record,
            parent: record.parent ?? null,
            createdAt: record.createdAt ?? now,
            updatedAt: record.updatedAt ?? now,
        }));
    if (!incoming.length) return 0;
    merge(incoming);
    markDirty(true);
    return incoming.length;
}

// ----- pushing -------------------------------------------------------------------

function markDirty(immediate) {
    dirty = true;
    publish();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(
        () => flush().catch(() => {}),
        immediate ? 0 : PUSH_DELAY,
    );
}

/**
 * Write the tree out, retrying through version conflicts. Resolves once the
 * server has everything changed before the call.
 */
export function flush() {
    if (!dek) return Promise.resolve();
    if (pushing) {
        // a change made during a push still needs a push of its own
        return pushing.then(() => (dirty ? flush() : undefined));
    }
    if (!dirty) return Promise.resolve();
    pushing = push().finally(() => {
        pushing = null;
        publish();
    });
    publish();
    return pushing;
}

async function push() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        dirty = false;
        const cutoff = Date.now() - TOMBSTONE_TTL;
        const list = [...records.values()].filter(
            (r) => !(r.deleted && r.updatedAt < cutoff),
        );
        try {
            const blob = await encryptJson(dek, { records: list }, LABEL);
            const res = await api.putTree(blob, version);
            version = res.version;
            syncError = null;
            return;
        } catch (error) {
            dirty = true;
            if (error instanceof ApiError && error.status === 409) {
                const remote = await pull();
                version = remote.version;
                merge(remote.records);
                publish();
                continue;
            }
            syncError = error;
            publish();
            // try again later; the change is still in memory and still dirty
            clearTimeout(pushTimer);
            pushTimer = setTimeout(() => flush().catch(() => {}), 5000);
            throw error;
        }
    }
}

// ----- mutations ------------------------------------------------------------------

function put(record) {
    records.set(record.id, {
        ...record,
        updatedAt: Math.max(Date.now(), (record.updatedAt ?? 0) + 1),
    });
}

export function createFolder(name, parent, { id, createdAt } = {}) {
    const now = Date.now();
    const record = {
        id: id ?? uuid4(),
        type: "folder",
        name,
        parent: parent ?? null,
        createdAt: createdAt ?? now,
        updatedAt: now,
    };
    put(record);
    markDirty();
    return record;
}

/**
 * A file whose bytes are not on Telegram yet; uploadQueue fills in file_id.
 *
 * `id` and `createdAt` are passed only when a resumed upload puts back a
 * record the vault never received (the tab closed before the tree was
 * pushed), so the upload log and the tree keep agreeing on the id.
 */
export function createFile({ id, name, parent, size, mime, createdAt }) {
    const now = Date.now();
    const record = {
        id: id ?? uuid4(),
        type: "file",
        name,
        parent: parent ?? null,
        size,
        mime,
        createdAt: createdAt ?? now,
        updatedAt: now,
    };
    put(record);
    markDirty();
    return record;
}

export function update(id, changes, { immediate = false } = {}) {
    const record = getRecord(id);
    if (!record) return undefined;
    put({ ...record, ...changes });
    markDirty(immediate);
    return records.get(id);
}

export function rename(id, name) {
    return update(id, { name });
}

export function setStarred(ids, starred) {
    for (const id of ids) {
        const record = getRecord(id);
        if (record) put({ ...record, starred });
    }
    markDirty();
}

export function trash(ids) {
    const now = Date.now();
    for (const id of ids) {
        const record = getRecord(id);
        if (record) put({ ...record, trashedAt: now });
    }
    markDirty();
}

export function restore(ids) {
    for (const id of ids) {
        const record = getRecord(id);
        if (!record) continue;
        const next = { ...record };
        delete next.trashedAt;
        // the old folder may be gone for good; land at the root instead
        if (next.parent && !getRecord(next.parent)) next.parent = null;
        put(next);
    }
    markDirty();
}

/** Can `id` move under `target` without becoming its own ancestor? */
export function canMove(id, target) {
    let cursor = target;
    while (cursor) {
        if (cursor === id) return false;
        cursor = getRecord(cursor)?.parent ?? null;
    }
    return true;
}

export function move(ids, target) {
    const moved = [];
    for (const id of ids) {
        const record = getRecord(id);
        if (
            !record ||
            !canMove(id, target) ||
            (record.parent ?? null) === (target ?? null)
        )
            continue;
        put({ ...record, parent: target ?? null });
        moved.push(id);
    }
    if (moved.length) markDirty();
    return moved;
}

/** Turn records into tombstones. The caller deletes Telegram messages first. */
export async function removeRecords(ids) {
    for (const id of ids) {
        if (records.has(id)) put({ id, deleted: true });
    }
    markDirty(true);
    await flush();
}

/** The adapter uploadQueue writes through. */
export const fileOps = {
    getByID: async (id) => getRecord(id),
    // the message id is the only link to bytes already on Telegram, so it goes
    // out right away rather than waiting for the debounce
    // `extra` carries what the way the file was sent changed (see uploadFile)
    setFileId: async (id, file_id, extra = {}) => {
        update(id, { ...extra, file_id }, { immediate: true });
        // a failed push stays dirty and retries; the tab warns before closing
        await flush().catch(() => {});
    },
};

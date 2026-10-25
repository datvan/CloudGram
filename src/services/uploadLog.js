/**
 * A note, kept on this device, of every upload that has not finished, so a
 * tab closed halfway can offer to pick up where it stopped (uploadResume.js).
 *
 * An entry says enough to put the file back on the queue: the record it fills
 * (with what it takes to recreate it, in case the tree never reached the
 * vault), where the bytes came from, which parts Telegram already has, and
 * whether the message may already have been sent. It is written when a file
 * is queued and dropped once the file_id is safely in the vault.
 *
 * Entries are encrypted with the vault key, like the tree: they hold file
 * names and Dropbox links. File handles cannot be: IndexedDB stores them as
 * objects, not bytes. They sit in a store of their own, which leaves their
 * names readable to anything with access to this browser profile; that is the
 * price of resuming without picking the files again.
 *
 * Every tab holds a Web Lock named after itself for as long as it is open. An
 * entry belongs to the tab that wrote it, and only entries whose tab is gone
 * are offered for resuming, so one tab never resumes another's live upload.
 */
import { v4 as uuid4 } from "uuid";

import { decryptJson, encryptJson } from "./crypto";

const DB = "CloudGramUploads";
const ENTRIES = "entries";
const HANDLES = "handles";
const LABEL = "upload-log";
const WRITE_DELAY = 250;
const TAB_LOCK = "cloudgram-tab-";

export const TAB = uuid4();

// held until the tab goes away; the browser lets go of it then
navigator.locks
    ?.request(TAB_LOCK + TAB, () => new Promise(() => {}))
    .catch(() => {});

let username = null;
let key = null;
/** What this tab has written, so a change does not have to read first. */
const mine = new Map();
/** Writes waiting to go out: an entry, or null for a delete. */
const pending = new Map();
const handleWrites = new Map();
let timer = null;
let writing = Promise.resolve();

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(ENTRIES);
            req.result.createObjectStore(HANDLES);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function transact(mode, work) {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction([ENTRIES, HANDLES], mode);
            const result = work(
                tx.objectStore(ENTRIES),
                tx.objectStore(HANDLES),
            );
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

const request = (req) =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

/** Called once the vault key is open; entries are per account. */
export function openUploadLog(name, dek) {
    username = name;
    key = dek;
}

export function closeUploadLog() {
    username = null;
    key = null;
    mine.clear();
}

// ----- writing ----------------------------------------------------------------

function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
        writing = writing.then(writeOut, writeOut);
    }, WRITE_DELAY);
}

async function writeOut() {
    if (!key || (!pending.size && !handleWrites.size)) return;
    const owner = username;
    const batch = [...pending];
    const handles = [...handleWrites];
    pending.clear();
    handleWrites.clear();
    // encrypted before the transaction opens: an IndexedDB transaction
    // commits on its own as soon as it is left waiting on anything else
    const sealed = await Promise.all(
        batch.map(async ([id, entry]) => [
            id,
            entry && {
                username: owner,
                blob: await encryptJson(key, entry, LABEL),
            },
        ]),
    );
    try {
        await transact("readwrite", (entries, handleStore) => {
            for (const [id, value] of sealed) {
                if (value) entries.put(value, id);
                else {
                    entries.delete(id);
                    handleStore.delete(id);
                }
            }
            for (const [id, handle] of handles) {
                handleStore.put({ username: owner, ...handle }, id);
            }
        });
    } catch (error) {
        // a private window may have no IndexedDB; uploads go on without it
        console.log(error);
    }
}

/** Write an entry whole. */
export function logEntry(id, entry) {
    if (!username) return;
    const full = { ...entry, id, tab: TAB };
    mine.set(id, full);
    pending.set(id, full);
    schedule();
}

/** Change some fields of an entry this tab wrote or claimed. */
export function patchEntry(id, changes) {
    const entry = mine.get(id);
    if (entry) logEntry(id, { ...entry, ...changes });
}

/** An entry this tab wrote or claimed. */
export const entryOf = (id) => mine.get(id);

export function dropEntry(id) {
    mine.delete(id);
    pending.set(id, null);
    schedule();
}

/** `handle` is { rootId, root, sub }: see pickers.js. */
export function saveHandle(id, handle) {
    if (!username || !handle) return;
    handleWrites.set(id, handle);
    schedule();
}

/** Let queued writes reach the disk, e.g. before reading the log back. */
export async function settleWrites() {
    clearTimeout(timer);
    writing = writing.then(writeOut, writeOut);
    await writing;
}

// ----- reading ----------------------------------------------------------------

/** Every entry of this account, with its file handle when there is one. */
export async function readEntries() {
    if (!key) return [];
    await settleWrites();
    let rows;
    try {
        rows = await transact("readonly", (entries, handles) => ({
            entries: request(entries.getAll()),
            keys: request(entries.getAllKeys()),
            handles: request(handles.getAll()),
            handleKeys: request(handles.getAllKeys()),
        }));
        rows = {
            entries: await rows.entries,
            keys: await rows.keys,
            handles: await rows.handles,
            handleKeys: await rows.handleKeys,
        };
    } catch (error) {
        console.log(error);
        return [];
    }
    const handleOf = new Map();
    rows.handleKeys.forEach((id, i) => {
        if (rows.handles[i].username === username)
            handleOf.set(id, rows.handles[i]);
    });
    const result = [];
    for (let i = 0; i < rows.keys.length; i += 1) {
        const row = rows.entries[i];
        if (row.username !== username) continue;
        try {
            const entry = await decryptJson(key, row.blob, LABEL);
            result.push({ ...entry, handle: handleOf.get(rows.keys[i]) });
        } catch {
            // sealed under an older key (another account on this browser
            // under the same name, recreated); nothing can read it
        }
    }
    return result;
}

/** Ids of the tabs open right now, this one included. */
export async function liveTabs() {
    const live = new Set([TAB]);
    try {
        const { held } = await navigator.locks.query();
        for (const lock of held) {
            if (lock.name.startsWith(TAB_LOCK))
                live.add(lock.name.slice(TAB_LOCK.length));
        }
    } catch {
        // no Web Locks: every other tab counts as gone
    }
    return live;
}

/**
 * Run `work` with no other tab doing the same, so two tabs reopened at once
 * cannot both claim the same entries.
 */
export function exclusively(work) {
    if (!navigator.locks) return work();
    return navigator.locks.request("cloudgram-resume", work);
}

/** Take entries from a closed tab over, so this tab owns them from now on. */
export function claim(entries) {
    for (const entry of entries) {
        const { handle, ...rest } = entry;
        logEntry(entry.id, rest);
        if (handle) saveHandle(entry.id, handle);
    }
}

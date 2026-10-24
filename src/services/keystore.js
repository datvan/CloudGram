/**
 * Where "remember me" keeps the unwrapped DEK between page loads.
 *
 * IndexedDB can hold a CryptoKey as-is, and the key was imported
 * non-extractable, so its bytes cannot be read back out of this store. Script
 * running on the page could still *use* it, which is the price of not asking
 * for the password on every reload; without "remember me" the key lives only
 * in memory and a reload asks again.
 */
const DB = "CloudGramKeys";
const STORE = "keys";

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function run(mode, action) {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = action(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req?.result);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function loadKey(username) {
    try {
        const entry = await run("readonly", (store) => store.get("dek"));
        return entry?.username === username ? entry.key : null;
    } catch {
        return null;
    }
}

export function saveKey(username, key) {
    return run("readwrite", (store) => store.put({ username, key }, "dek"));
}

export async function clearKey() {
    try {
        await run("readwrite", (store) => store.delete("dek"));
    } catch {
        // nothing stored, or storage blocked: either way there is no key left
    }
}

/**
 * One id per browser profile, shared by its tabs. Tabs of one browser share an
 * IP, which Telegram tolerates, so they may share the lease.
 */
export function browserId() {
    try {
        let id = localStorage.getItem("cloudgram.browserId");
        if (!id) {
            id = crypto.randomUUID().replaceAll("-", "");
            localStorage.setItem("cloudgram.browserId", id);
        }
        return id;
    } catch {
        // storage blocked: a per-load id still works, it just will not be shared
        return (window.__cgBrowserId ??= crypto
            .randomUUID()
            .replaceAll("-", ""));
    }
}

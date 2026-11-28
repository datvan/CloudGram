const DB = "CloudGramTree";
const STORE = "trees";

function openCache() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Tree cache blocked"));
    });
}

async function transaction(mode, run) {
    const db = await openCache();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            let value;
            run(tx.objectStore(STORE), (result) => {
                value = result;
            });
            tx.oncomplete = () => resolve(value);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

export function readTreeCache(account) {
    return transaction("readonly", (store, done) => {
        const request = store.get(account);
        request.onsuccess = () => done(request.result);
    });
}

export function writeTreeCache(account, value, { force = false } = {}) {
    return transaction("readwrite", (store) => {
        const request = store.get(account);
        request.onsuccess = () => {
            if (force || !(request.result?.version > value.version))
                store.put(value, account);
        };
    });
}

export function clearTreeCache(account) {
    if (!account) return Promise.resolve();
    return transaction("readwrite", (store) => store.delete(account));
}

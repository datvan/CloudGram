/**
 * Browser-side encryption for everything CloudGram stores on the VPS.
 *
 *     password ──PBKDF2-SHA256──► 512 bits
 *                                  ├─ first half  → loginKey (sent to the server,
 *                                  │                which keeps only scrypt of it)
 *                                  └─ second half → KEK (never leaves the browser)
 *
 *     DEK (random AES-256-GCM) ── wrapped by the KEK, stored on the server
 *                              └─ encrypts the Telegram session and the file tree
 *
 * The server can check a password but cannot derive the KEK from what it
 * receives, so it never holds anything that decrypts the vault. A password
 * change re-wraps the DEK and leaves the blobs alone.
 *
 * Only WebCrypto, so the same file runs under Node's test runner.
 */
const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ITERATIONS = 600_000;

export function toBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (let i = 0; i < view.length; i += 0x8000) {
        binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

const toHex = (bytes) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function randomBase64(size) {
    return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(size)));
}

export function newKdf() {
    return { salt: randomBase64(16), iterations: ITERATIONS };
}

/** Stretch the password once and split it into the login key and the KEK. */
export async function deriveKeys(password, kdf) {
    const base = await subtle.importKey(
        "raw",
        encoder.encode(password.normalize("NFKC")),
        "PBKDF2",
        false,
        ["deriveBits"],
    );
    const bits = new Uint8Array(
        await subtle.deriveBits(
            {
                name: "PBKDF2",
                hash: "SHA-256",
                salt: fromBase64(kdf.salt),
                iterations: kdf.iterations,
            },
            base,
            512,
        ),
    );
    const kek = await subtle.importKey(
        "raw",
        bits.slice(32),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
    );
    return { loginKey: toHex(bits.slice(0, 32)), kek };
}

/** A fresh DEK, sealed under the KEK. Returns both the usable key and its wrap. */
export async function createDek(kek) {
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const wrappedDek = await encryptBytes(kek, raw, "cloudgram-dek");
    const dek = await importDek(raw);
    raw.fill(0);
    return { dek, wrappedDek };
}

/**
 * Open the DEK as a non-extractable key: script on the page can still use it,
 * but cannot read its bytes out, so it cannot be copied off the device.
 */
export async function unwrapDek(kek, wrappedDek) {
    const raw = await decryptBytes(kek, wrappedDek, "cloudgram-dek");
    const dek = await importDek(raw);
    raw.fill(0);
    return dek;
}

/** Re-seal the same DEK under a new KEK, for a password change. */
export async function rewrapDek(oldKek, wrappedDek, newKek) {
    const raw = await decryptBytes(oldKek, wrappedDek, "cloudgram-dek");
    const rewrapped = await encryptBytes(newKek, raw, "cloudgram-dek");
    raw.fill(0);
    return rewrapped;
}

function importDek(raw) {
    return subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
        "decrypt",
    ]);
}

// The label is bound in as additional data, so a session blob can never be
// swapped in where the tree is expected, or the other way round.
async function encryptBytes(key, bytes, label) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(label) },
        key,
        bytes,
    );
    return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function decryptBytes(key, blob, label) {
    const plain = await subtle.decrypt(
        {
            name: "AES-GCM",
            iv: fromBase64(blob.iv),
            additionalData: encoder.encode(label),
        },
        key,
        fromBase64(blob.ct),
    );
    return new Uint8Array(plain);
}

export async function encryptJson(dek, value, label) {
    return encryptBytes(dek, encoder.encode(JSON.stringify(value)), label);
}

export async function decryptJson(dek, blob, label) {
    return JSON.parse(decoder.decode(await decryptBytes(dek, blob, label)));
}

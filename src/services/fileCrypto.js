export const CHUNK = 512 * 1024;
export const ENC_CHUNK = CHUNK + 16;

const base64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unbase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function newFileKey() {
    return {
        v: 1,
        key: base64(crypto.getRandomValues(new Uint8Array(32))),
        nonce: base64(crypto.getRandomValues(new Uint8Array(4))),
        chunk: CHUNK,
    };
}

export const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));
export const encryptedSize = (size) => size + chunkCount(size) * 16;

export const importFileKey = (enc) =>
    crypto.subtle.importKey("raw", unbase64(enc.key), "AES-GCM", false, [
        "encrypt",
        "decrypt",
    ]);

function params(enc, index, isLast) {
    const iv = new Uint8Array(12);
    iv.set(unbase64(enc.nonce));
    new DataView(iv.buffer).setBigUint64(4, BigInt(index));
    return {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(
            `cg-file-v1:${index}:${isLast ? "1" : "0"}`,
        ),
    };
}

export async function encryptChunk(key, enc, index, bytes, isLast) {
    return new Uint8Array(
        await crypto.subtle.encrypt(params(enc, index, isLast), key, bytes),
    );
}

export async function decryptChunk(key, enc, index, bytes, isLast) {
    return new Uint8Array(
        await crypto.subtle.decrypt(params(enc, index, isLast), key, bytes),
    );
}

export function plainRangeToCipher(enc, start, endInclusive) {
    const firstChunk = Math.floor(start / CHUNK);
    const lastChunk = Math.floor(endInclusive / CHUNK);
    return {
        firstChunk,
        lastChunk,
        cipherStart: firstChunk * ENC_CHUNK,
        cipherEnd:
            Math.min((lastChunk + 1) * ENC_CHUNK, encryptedSize(enc.size)) - 1,
    };
}

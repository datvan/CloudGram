const MAX_SIZE = 8 * 1024 * 1024;

function parameters(purpose) {
    if (purpose !== "thumbnail" && purpose !== "storyboard") {
        throw new Error("Invalid preview purpose");
    }
    return new TextEncoder().encode(`cloudgram:${purpose}:v1`);
}

function decode(value, length) {
    if (typeof value !== "string") throw new Error("Invalid base64");
    let bytes;
    try {
        bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    } catch {
        throw new Error("Invalid base64");
    }
    if (
        bytes.length !== length ||
        btoa(String.fromCharCode(...bytes)) !== value
    ) {
        throw new Error("Invalid base64 or length");
    }
    return bytes;
}

export async function encryptPreview(blob, purpose) {
    const additionalData = parameters(purpose);
    if (!(blob instanceof Blob) || blob.size > MAX_SIZE) {
        throw new Error("Invalid preview size");
    }
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "encrypt",
    ]);
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
        key,
        await blob.arrayBuffer(),
    );
    return {
        ciphertext: new Blob([ciphertext], {
            type: "application/octet-stream",
        }),
        metadata: {
            v: 1,
            key: btoa(String.fromCharCode(...raw)),
            nonce: btoa(String.fromCharCode(...nonce)),
        },
    };
}

export async function decryptPreview(blob, metadata, purpose) {
    const additionalData = parameters(purpose);
    if (
        !(blob instanceof Blob) ||
        blob.size < 16 ||
        blob.size > MAX_SIZE + 16
    ) {
        throw new Error("Invalid ciphertext size");
    }
    if (!metadata || metadata.v !== 1)
        throw new Error("Invalid preview version");
    const raw = decode(metadata.key, 32);
    const nonce = decode(metadata.nonce, 12);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "decrypt",
    ]);
    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
        key,
        await blob.arrayBuffer(),
    );
    return new Blob([plaintext], { type: "image/jpeg" });
}

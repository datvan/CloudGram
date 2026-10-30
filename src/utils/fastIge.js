import AES from "@cryptography/aes";

// The AES decryption tables, built the way @cryptography/aes builds its own.
const Si = new Uint8Array(256);
const T5 = new Int32Array(256);
const T6 = new Int32Array(256);
const T7 = new Int32Array(256);
const T8 = new Int32Array(256);
{
    const S = new Uint8Array(256);
    const d = new Uint8Array(256);
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        d[i] = (i << 1) ^ ((i >> 7) * 283);
        t[d[i] ^ i] = i;
    }
    for (let x = 0, xInv = 0, x2 = 0, x4, x8; !S[x]; x ^= x2 || 1) {
        let s = xInv ^ (xInv << 1) ^ (xInv << 2) ^ (xInv << 3) ^ (xInv << 4);
        s = (s >> 8) ^ (s & 255) ^ 99;
        S[x] = s;
        Si[s] = x;
        x8 = d[(x4 = d[(x2 = d[x])])];
        let tDec =
            (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100);
        T5[s] = tDec = (tDec << 24) ^ (tDec >>> 8);
        T6[s] = tDec = (tDec << 24) ^ (tDec >>> 8);
        T7[s] = tDec = (tDec << 24) ^ (tDec >>> 8);
        T8[s] = tDec = (tDec << 24) ^ (tDec >>> 8);
        xInv = t[xInv] || 1;
    }
}

const word = (b, i) =>
    (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];

function put(b, i, w) {
    b[i] = w >>> 24;
    b[i + 1] = w >>> 16;
    b[i + 2] = w >>> 8;
    b[i + 3] = w;
}

/**
 * AES-256-IGE decryption of `data` (whole 16-byte blocks) into new bytes.
 *
 * Gives the same bytes as GramJS's own IGE, which goes through
 * @cryptography/aes block by block, making several small arrays for each and
 * then copying every word out again. Doing the rounds in place, with nothing
 * made per block, is what lets a download go faster than that decrypts:
 * Telegram encrypts everything it sends, and this is where a download spends
 * most of its time.
 */
export function decryptIge(data, key, iv) {
    const k = new AES(key).decKey;
    const rounds = k.length / 4 - 2;
    const out = new Uint8Array(data.length);
    // IGE chains on both the previous cipher block and the previous plain one
    let x0 = word(iv, 0);
    let x1 = word(iv, 4);
    let x2 = word(iv, 8);
    let x3 = word(iv, 12);
    let y0 = word(iv, 16);
    let y1 = word(iv, 20);
    let y2 = word(iv, 24);
    let y3 = word(iv, 28);
    for (let i = 0; i < data.length; i += 16) {
        const c0 = word(data, i);
        const c1 = word(data, i + 4);
        const c2 = word(data, i + 8);
        const c3 = word(data, i + 12);
        let a = c0 ^ y0 ^ k[0];
        let b = c3 ^ y3 ^ k[1];
        let c = c2 ^ y2 ^ k[2];
        let d = c1 ^ y1 ^ k[3];
        let n = 4;
        for (let r = 0; r < rounds; r++) {
            const a2 =
                T5[a >>> 24] ^
                T6[(b >> 16) & 255] ^
                T7[(c >> 8) & 255] ^
                T8[d & 255] ^
                k[n];
            const b2 =
                T5[b >>> 24] ^
                T6[(c >> 16) & 255] ^
                T7[(d >> 8) & 255] ^
                T8[a & 255] ^
                k[n + 1];
            const c2b =
                T5[c >>> 24] ^
                T6[(d >> 16) & 255] ^
                T7[(a >> 8) & 255] ^
                T8[b & 255] ^
                k[n + 2];
            d =
                T5[d >>> 24] ^
                T6[(a >> 16) & 255] ^
                T7[(b >> 8) & 255] ^
                T8[c & 255] ^
                k[n + 3];
            a = a2;
            b = b2;
            c = c2b;
            n += 4;
        }
        // the last round, in the column order @cryptography/aes writes it
        const p0 =
            ((Si[a >>> 24] << 24) |
                (Si[(b >> 16) & 255] << 16) |
                (Si[(c >> 8) & 255] << 8) |
                Si[d & 255]) ^
            k[n];
        const p3 =
            ((Si[b >>> 24] << 24) |
                (Si[(c >> 16) & 255] << 16) |
                (Si[(d >> 8) & 255] << 8) |
                Si[a & 255]) ^
            k[n + 1];
        const p2 =
            ((Si[c >>> 24] << 24) |
                (Si[(d >> 16) & 255] << 16) |
                (Si[(a >> 8) & 255] << 8) |
                Si[b & 255]) ^
            k[n + 2];
        const p1 =
            ((Si[d >>> 24] << 24) |
                (Si[(a >> 16) & 255] << 16) |
                (Si[(b >> 8) & 255] << 8) |
                Si[c & 255]) ^
            k[n + 3];
        y0 = p0 ^ x0;
        y1 = p1 ^ x1;
        y2 = p2 ^ x2;
        y3 = p3 ^ x3;
        put(out, i, y0);
        put(out, i + 4, y1);
        put(out, i + 8, y2);
        put(out, i + 12, y3);
        x0 = c0;
        x1 = c1;
        x2 = c2;
        x3 = c3;
    }
    return out;
}

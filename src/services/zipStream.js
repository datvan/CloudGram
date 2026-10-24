/**
 * Read a ZIP front to back as it streams in, without ever seeing the end.
 *
 * Dropbox builds a folder's ZIP on the fly and serves it without byte ranges,
 * so the central directory at the end cannot be read first. The entries come
 * one after another instead, each a local header followed by its bytes. When
 * the header does not know the size (bit 3, which is what Dropbox sends), the
 * entry ends at a data descriptor; one is accepted only when the sizes it
 * states equal the bytes actually seen, so file content that happens to
 * contain the signature does not cut an entry short. The CRC is checked too.
 *
 * Only stored (uncompressed) entries are supported, which is what Dropbox
 * produces. Pure JavaScript, so Node can test it.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const DESCRIPTOR = 0x08074b50;
const MAX32 = 0xffffffff;

export class ZipError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crcUpdate(crc, bytes) {
    let c = crc ^ MAX32;
    for (let i = 0; i < bytes.length; i += 1)
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ MAX32) >>> 0;
}

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) =>
    (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u64 = (b, at) => u32(b, at) + u32(b, at + 4) * 2 ** 32;

function concat(a, b) {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

const utf8 = new TextDecoder("utf-8");

/**
 * Feed it chunks with `push`, then call `end`. It calls back:
 *
 *   onEntry({ path, dir })   an entry starts (paths use "/", no leading "/")
 *   onData(bytes)            file bytes, in order; valid only during the call
 *   onEntryEnd({ size })     the entry is complete and its CRC matched
 */
export class ZipReader {
    constructor({ onEntry, onData, onEntryEnd }) {
        this.on = { onEntry, onData, onEntryEnd };
        this.buf = new Uint8Array(0);
        this.state = "header";
        this.entry = null;
    }

    push(chunk) {
        if (this.state === "done") return;
        this.buf = concat(this.buf, chunk);
        for (;;) {
            const before = this.state;
            const progressed =
                this.state === "header"
                    ? this.#header()
                    : this.state === "sized"
                    ? this.#sized()
                    : this.state === "scan"
                    ? this.#scan()
                    : false;
            if (!progressed && before === this.state) break;
        }
        // whatever is left is a header or descriptor still arriving; copy it so
        // the caller's chunk is not pinned behind a small view
        if (this.buf.length && this.buf.buffer.byteLength > this.buf.length * 4)
            this.buf = this.buf.slice();
    }

    end() {
        if (this.state !== "done") throw new ZipError("zip_truncated");
    }

    #header() {
        const b = this.buf;
        if (b.length < 4) return false;
        const sig = u32(b, 0);
        if (sig === CENTRAL || sig === END || sig === END64) {
            this.state = "done";
            this.buf = new Uint8Array(0);
            return true;
        }
        if (sig !== LOCAL) throw new ZipError("zip_corrupt");
        if (b.length < 30) return false;
        const flags = u16(b, 6);
        const method = u16(b, 8);
        let size = u32(b, 18);
        const nameLength = u16(b, 26);
        const extraLength = u16(b, 28);
        const headerLength = 30 + nameLength + extraLength;
        if (b.length < headerLength) return false;

        if (flags & 1) throw new ZipError("zip_encrypted");
        const name = utf8.decode(b.subarray(30, 30 + nameLength));
        const extra = b.subarray(30 + nameLength, headerLength);
        let zip64 = false;
        for (let at = 0; at + 4 <= extra.length; ) {
            const id = u16(extra, at);
            const length = u16(extra, at + 2);
            if (id === 1) {
                zip64 = true;
                if (size === MAX32 && length >= 16)
                    size = u64(extra, at + 4 + 8);
            }
            at += 4 + length;
        }

        const path = name.replace(/\\/g, "/").replace(/^\/+/, "");
        const dir = name.endsWith("/");
        const streamed = Boolean(flags & 8);
        if (method !== 0 && !(dir || (!streamed && size === 0)))
            throw new ZipError("zip_compressed");

        this.buf = b.subarray(headerLength);
        this.entry = { path, dir, size, seen: 0, crc: 0, zip64 };
        this.on.onEntry({ path, dir });
        this.state = streamed ? "scan" : "sized";
        return true;
    }

    #emit(bytes) {
        if (!bytes.length) return;
        this.entry.seen += bytes.length;
        this.entry.crc = crcUpdate(this.entry.crc, bytes);
        this.on.onData(bytes);
    }

    #finish(size, crc) {
        if (crc !== undefined && crc !== this.entry.crc)
            throw new ZipError("zip_crc");
        this.on.onEntryEnd({ size });
        this.entry = null;
        this.state = "header";
    }

    #sized() {
        const want = this.entry.size - this.entry.seen;
        const take = Math.min(want, this.buf.length);
        this.#emit(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        if (this.entry.seen < this.entry.size) return take > 0;
        this.#finish(this.entry.size);
        return true;
    }

    /**
     * Look for the descriptor that ends a streamed entry. A candidate is a
     * signature whose stated sizes match the bytes before it and which is
     * followed by the next header; a candidate that has not fully arrived
     * holds back everything from it on.
     */
    #scan() {
        const b = this.buf;
        let from = 0;
        for (;;) {
            const at = b.indexOf(0x50, from);
            if (at < 0 || at + 4 > b.length) {
                // nothing here; keep the last 3 bytes in case a signature is split
                const safe =
                    at < 0 ? Math.max(0, b.length - 3) : Math.max(0, at);
                this.#emit(b.subarray(0, safe));
                this.buf = b.subarray(safe);
                return false;
            }
            if (u32(b, at) !== DESCRIPTOR) {
                from = at + 1;
                continue;
            }
            const seen = this.entry.seen + at;
            const forms = this.entry.zip64 ? [24, 16] : [16, 24];
            let waiting = false;
            for (const length of forms) {
                if (at + length + 4 > b.length) {
                    waiting = true;
                    continue;
                }
                const sizes =
                    length === 16
                        ? [u32(b, at + 8), u32(b, at + 12)]
                        : [u64(b, at + 8), u64(b, at + 16)];
                const expected = length === 16 ? seen % 2 ** 32 : seen;
                const next = u32(b, at + length);
                if (
                    sizes[0] === expected &&
                    sizes[1] === expected &&
                    (next === LOCAL ||
                        next === CENTRAL ||
                        next === END ||
                        next === END64)
                ) {
                    this.#emit(b.subarray(0, at));
                    const crc = u32(b, at + 4);
                    this.buf = b.subarray(at + length);
                    this.#finish(seen, crc);
                    return true;
                }
            }
            if (waiting) {
                this.#emit(b.subarray(0, at));
                this.buf = b.subarray(at);
                return false;
            }
            from = at + 1;
        }
    }
}

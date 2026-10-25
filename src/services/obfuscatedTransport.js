/**
 * GramJS's websocket transport, with the obfuscation done by WebCrypto.
 *
 * Every byte to and from Telegram goes through an AES-256-CTR layer that
 * disguises the MTProto traffic. GramJS does it in plain JavaScript, a byte at
 * a time, at about 10 MB/s: 50 ms of main-thread work for each 512 KB upload
 * part, which capped a tab at 5-6 MB/s whatever the connection. The browser's
 * own AES does the same part in well under a millisecond, off the main thread.
 *
 * WebCrypto only answers asynchronously, so sending awaits the encryption.
 * Order is still kept: GramJS sends one packet at a time and reads one at a
 * time, and each call takes its place in the stream before it awaits anything.
 */
import { Buffer } from "buffer/";
import { ConnectionTCPObfuscated } from "telegram/network";

/** One direction of the CTR stream, encrypting from wherever it left off. */
class CtrStream {
    constructor(key, iv) {
        this.key = crypto.subtle.importKey("raw", key, "AES-CTR", false, [
            "encrypt",
        ]);
        this.iv = iv;
        this.offset = 0;
    }

    /** The counter `blocks` blocks past the start: the iv plus that, mod 2^128. */
    counterAt(blocks) {
        const counter = Uint8Array.from(this.iv);
        let carry = blocks;
        for (let i = 15; i >= 0 && carry > 0; i -= 1) {
            const sum = counter[i] + (carry % 256);
            counter[i] = sum % 256;
            carry = Math.floor(carry / 256) + (sum >= 256 ? 1 : 0);
        }
        return counter;
    }

    async apply(data) {
        // claimed now, so a later call starts after this one whenever it runs
        const start = this.offset;
        this.offset += data.length;
        // a stream that stopped mid-block resumes inside it: pad up to there
        const skip = start % 16;
        let input = data;
        if (skip) {
            input = new Uint8Array(skip + data.length);
            input.set(data, skip);
        }
        const out = await crypto.subtle.encrypt(
            {
                name: "AES-CTR",
                counter: this.counterAt(Math.floor(start / 16)),
                length: 128,
            },
            await this.key,
            input,
        );
        return Buffer.from(out, skip, data.length);
    }
}

// first words a server could take for another protocol (core.telegram.org/
// mtproto/mtproto-transports, "Transport obfuscation"): HEAD, POST, GET,
// OPTI, PVrG, a TLS record, and the padded intermediate and intermediate tags
const RESERVED = [
    0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0x47725650, 0x02010316,
    0xdddddddd, 0xeeeeeeee,
];

function headerSeed() {
    for (;;) {
        const random = crypto.getRandomValues(new Uint8Array(64));
        const view = new DataView(random.buffer);
        if (random[0] === 0xef || view.getUint32(4) === 0) continue;
        if (RESERVED.includes(view.getUint32(0, true))) continue;
        return random;
    }
}

class ObfuscatedIO {
    constructor(connection) {
        this.socket = connection.socket;
        this.tag = connection.PacketCodecClass.obfuscateTag;
        this.written = Promise.resolve();
    }

    async initHeader() {
        const random = headerSeed();
        random.set(this.tag, 56);
        const reversed = random.slice(8, 56).reverse();
        this.encryptor = new CtrStream(
            random.slice(8, 40),
            random.slice(40, 56),
        );
        this.decryptor = new CtrStream(
            reversed.slice(0, 32),
            reversed.slice(32),
        );
        // the whole header goes through the stream, but only its last 8 bytes
        // go out encrypted
        const encrypted = await this.encryptor.apply(random);
        random.set(encrypted.subarray(56, 64), 56);
        this.header = Buffer.from(random);
    }

    async read(n) {
        return this.decryptor.apply(await this.socket.readExactly(n));
    }

    write(data) {
        // a small packet can come back from WebCrypto before a big one sent
        // ahead of it; the socket still gets them in stream order
        const encrypted = this.encryptor.apply(data);
        const written = this.written.then(async () =>
            this.socket.write(await encrypted),
        );
        this.written = written.catch(() => {});
        return written;
    }
}

export class ConnectionWebCryptoObfuscated extends ConnectionTCPObfuscated {
    constructor(...args) {
        super(...args);
        this.ObfuscatedIO = ObfuscatedIO;
    }

    async _send(data) {
        // GramJS's own does not wait for the write, which was synchronous there
        await this._obfuscation.write(this._codec.encodePacket(data));
    }
}

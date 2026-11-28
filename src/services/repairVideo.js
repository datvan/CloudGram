import { canRepair, repairVideo } from "./convert.js";
import { realDeps, replaceRecord } from "./reencrypt.js";
import { uploadScope } from "./uploadLog";

export async function repairRecord(record, { signal, onProgress, deps } = {}) {
    if (!canRepair(record)) throw new Error("Không thể sửa tệp video này");
    const scopeOf = deps?.uploadScope ?? uploadScope;
    const scope = scopeOf();
    const assertScope = () => {
        if (!scope || scopeOf() !== scope)
            throw new DOMException("Phiên tải lên đã thay đổi", "AbortError");
    };
    const assertCurrent = () => {
        signal?.throwIfAborted();
        assertScope();
    };
    assertCurrent();
    const api = deps ?? (await realDeps());
    assertCurrent();
    const client = deps?.client ?? (await import("./telegram.js")).getClient();
    assertCurrent();
    const name = /\.mp4$/i.test(record.name)
        ? record.name
        : `${record.name.replace(/\.[^.]+$/, "")}.mp4`;
    const uploadRecord = { ...record, name, mime: "video/mp4" };
    const changes = { name, mime: "video/mp4" };
    return replaceRecord(record, {
        source: client,
        destination: client,
        signal,
        onProgress,
        deps: api,
        encrypted: Boolean(record.enc),
        assertCurrent,
        assertScope,
        checkThumbnail: true,
        checkMediaReferences: true,
        uploadRecord,
        extraChanges: changes,
        sameTelegram: (other) =>
            (other.tg === "shared") === (record.tg === "shared"),
        transform: async (blob) => {
            const result = await (deps?.repairVideo ?? repairVideo)(
                blob,
                record.name,
                (percentage) => onProgress?.({ phase: "repair", percentage }),
            );
            changes.size = result.size;
            return result;
        },
    });
}

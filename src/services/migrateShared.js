const liveFile = (record) => record.type === "file" && !record.deleted;
let migrating = false;
export const isMigrating = () => migrating;

async function realDeps() {
    const [account, drive, telegram, auth, reencrypt] = await Promise.all([
        import("./account.js"),
        import("./drive.js"),
        import("./telegram.js"),
        import("./telegramAuth.js"),
        import("./reencrypt.js"),
    ]);
    return { ...account, ...drive, ...telegram, ...auth, ...reencrypt };
}

export async function needsMigrationResume(deps) {
    const api = deps ?? (await realDeps());
    return (
        (await api.getTelegramMode()) === "private" &&
        api
            .getSnapshot()
            .records.some(
                (record) => liveFile(record) && record.tg === "shared",
            )
    );
}

export async function migrateToShared({
    deleteOriginal = false,
    onProgress,
    signal,
    deps,
} = {}) {
    if (migrating)
        throw Object.assign(new Error("Migration already in progress"), {
            code: "uploads_busy",
        });
    migrating = true;
    let destination;
    let adopted = false;
    try {
        const hasActiveUploads =
            deps?.hasActiveUploads ??
            (await import("../utils/uploadQueue.js")).hasActiveUploads;
        if (hasActiveUploads())
            throw Object.assign(
                new Error("Đang có file tải lên, hãy đợi tải xong rồi chuyển."),
                { code: "uploads_busy" },
            );
        const api = deps ?? (await realDeps());
        const source = api.getClient();
        signal?.throwIfAborted();
        destination = await api.openSharedClient();
        const failed = [];
        let done = 0;
        for (const record of api.getSnapshot().records.filter(liveFile)) {
            signal?.throwIfAborted();
            if (record.tg === "shared") continue;
            try {
                await api.reencryptRecord(record, {
                    source,
                    destination,
                    deleteOriginal,
                    signal,
                    extraChanges: {
                        tg: "shared",
                        thumbnail: undefined,
                        thumbnailBlob: undefined,
                        storyboard: undefined,
                    },
                    sameTelegram: (r) => r.tg !== "shared",
                    deleteOriginalMedia: true,
                    onProgress: (progress) =>
                        onProgress?.({ id: record.id, ...progress }),
                });
                done++;
            } catch (error) {
                signal?.throwIfAborted();
                failed.push({
                    id: record.id,
                    message: error.message ?? String(error),
                });
            }
        }
        signal?.throwIfAborted();
        for (const record of api.getSnapshot().records.filter(liveFile)) {
            if (
                record.tg !== "shared" &&
                !failed.some((item) => item.id === record.id)
            )
                failed.push({
                    id: record.id,
                    message: "File was not migrated",
                });
        }
        if (!failed.length) {
            await api.adoptTelegram(destination, "shared");
            adopted = true;
            await source.destroy();
        }
        return { done, failed };
    } finally {
        try {
            if (destination && !adopted)
                await destination.destroy().catch(() => {});
        } finally {
            migrating = false;
        }
    }
}

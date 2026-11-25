const liveFile = (record) => record.type === "file" && !record.deleted;

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
    const api = deps ?? (await realDeps());
    const source = api.getClient();
    signal?.throwIfAborted();
    const destination = await api.openSharedClient();
    let adopted = false;
    const failed = [];
    let done = 0;
    try {
        for (const record of api.getSnapshot().records.filter(liveFile)) {
            signal?.throwIfAborted();
            if (record.tg === "shared") continue;
            try {
                await api.reencryptRecord(record, {
                    source,
                    destination,
                    deleteOriginal,
                    signal,
                    extraChanges: { tg: "shared" },
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
        if (!adopted) await destination.destroy().catch(() => {});
    }
}

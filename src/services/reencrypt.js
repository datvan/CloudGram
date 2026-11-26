import { messagesOf } from "../utils/splitPlan.js";

/** Old messages still referenced by another file must remain on Telegram. */
export function unsharedMessages(
    record,
    records,
    sameTelegram = () => true,
    includeMedia = false,
) {
    const idsOf = (item) => [
        ...messagesOf(item),
        ...(includeMedia
            ? [
                  item.thumbnail,
                  item.thumbnailBlob?.message,
                  item.storyboard?.message,
              ].filter((id) => id != null)
            : []),
    ];
    const referenced = new Set(
        records
            .filter(
                (other) =>
                    other.id !== record.id &&
                    !other.deleted &&
                    sameTelegram(other),
            )
            .flatMap(idsOf),
    );
    return [...new Set(idsOf(record))].filter((id) => !referenced.has(id));
}

async function realDeps() {
    const [{ fetchFile }, { default: uploadFile }, drive] = await Promise.all([
        import("../utils/downloadFile.js"),
        import("../utils/uploadFile.js"),
        import("./drive.js"),
    ]);
    return {
        readPlain: (record, { source, onProgress, signal }) =>
            fetchFile(record.id, record.file_id, {
                quiet: true,
                client: source,
                onProgress,
                signal,
            }),
        uploadEncrypted: async (
            record,
            blob,
            { destination, onProgress, signal, resume },
        ) => {
            const parts = record.parts?.length > 1 ? record.parts : null;
            if (!parts)
                return uploadFile(
                    record.id,
                    new File([blob], record.name, { type: record.mime }),
                    {
                        client: destination,
                        resume,
                        onProgress,
                        assertCurrent: () => signal?.throwIfAborted(),
                    },
                );
            const sent = (resume.pieces = []);
            let offset = 0;
            for (const part of parts) {
                const partResume = { encrypted: true };
                let result;
                try {
                    result = await uploadFile(
                        record.id,
                        new File(
                            [blob.slice(offset, offset + part.size)],
                            record.name,
                            {
                                type: record.mime,
                            },
                        ),
                        {
                            client: destination,
                            resume: partResume,
                            onProgress: (percentage) =>
                                onProgress?.(
                                    ((offset + (part.size * percentage) / 100) /
                                        blob.size) *
                                        100,
                                ),
                            assertCurrent: () => signal?.throwIfAborted(),
                        },
                    );
                } finally {
                    sent.push(...(partResume.pieces ?? []));
                }
                if (!partResume.pieces?.length)
                    sent.push({
                        id: result.message.id,
                        size: part.size,
                        enc: result.changes.enc,
                    });
                offset += part.size;
            }
            return {
                message: { id: sent[0].id },
                messages: sent.map((part) => part.id),
                changes: { sentAs: "file", parts: sent },
            };
        },
        update: drive.update,
        flush: drive.flush,
        getSnapshot: drive.getSnapshot,
        deleteMessages: (client, ids) =>
            client.deleteMessages("me", ids, { revoke: true }),
        copyThumbnail: async (thumbnail, source, destination) => {
            const [{ uploadParts }] = await Promise.all([
                import("../utils/transfer.js"),
            ]);
            const [message] = await source.getMessages("me", {
                ids: [thumbnail.message],
            });
            if (!message?.media) throw new Error("Thumbnail not found");
            const bytes = await source.downloadMedia(message.media, {});
            const file = new File([bytes], "cloudgram-thumbnail-v1.bin", {
                type: "application/octet-stream",
            });
            return destination.sendFile("me", {
                file: await uploadParts(destination, file),
                forceDocument: true,
            });
        },
    };
}

export async function reencryptRecord(
    record,
    {
        source,
        destination,
        deleteOriginal = true,
        onProgress,
        signal,
        deps,
        extraChanges,
        sameTelegram = () => true,
        deleteOriginalMedia = false,
    },
) {
    const api = deps ?? (await realDeps());
    const resume = { encrypted: true };
    let uploaded;
    let thumbnail;
    let changed = false;
    let saved = false;
    const check = () => signal?.throwIfAborted();
    try {
        check();
        const blob = await api.readPlain(record, {
            source,
            signal,
            onProgress: (percentage) =>
                onProgress?.({ phase: "read", percentage }),
        });
        check();
        uploaded = await api.uploadEncrypted(record, blob, {
            destination,
            signal,
            resume,
            onProgress: (percentage) =>
                onProgress?.({ phase: "upload", percentage }),
        });
        if (source !== destination && record.thumbnailBlob?.message != null) {
            thumbnail = await api.copyThumbnail(
                record.thumbnailBlob,
                source,
                destination,
            );
        }
        check();
        const current = api
            .getSnapshot()
            .records.find((item) => item.id === record.id);
        if (
            !current ||
            JSON.stringify(messagesOf(current)) !==
                JSON.stringify(messagesOf(record)) ||
            JSON.stringify(current.thumbnailBlob) !==
                JSON.stringify(record.thumbnailBlob)
        )
            throw new Error("File changed during encryption");
        const changes = {
            ...uploaded.changes,
            ...extraChanges,
            ...(thumbnail && {
                thumbnailBlob: {
                    ...record.thumbnailBlob,
                    message: thumbnail.id,
                },
            }),
            file_id: uploaded.message.id,
        };
        if (!changes.parts) changes.parts = undefined;
        if (!changes.enc) changes.enc = undefined;
        changed = true;
        if (!api.update(record.id, changes, { preserveModifiedAt: true }))
            throw new Error("File no longer exists");
        await api.flush();
        saved = true;
    } catch (error) {
        let safeToDelete = !changed;
        if (changed && !saved) {
            const changes = {};
            for (const key of Object.keys({
                ...uploaded.changes,
                ...extraChanges,
                file_id: null,
                parts: null,
                enc: null,
                ...(thumbnail && { thumbnailBlob: null }),
            }))
                changes[key] = record[key];
            api.update(record.id, changes, { preserveModifiedAt: true });
            try {
                await api.flush();
                safeToDelete = true;
            } catch {
                // The server may have saved the new ids before the failed response.
            }
        }
        const ids = [
            ...new Set([
                ...(resume.pieces ?? []).map((p) => p.id),
                ...(uploaded?.messages ?? []),
                ...(uploaded?.message ? [uploaded.message.id] : []),
                ...(thumbnail ? [thumbnail.id] : []),
            ]),
        ];
        if (safeToDelete && ids.length)
            await api.deleteMessages(destination, ids).catch(() => {});
        throw error;
    }
    if (deleteOriginal) {
        const records = api.getSnapshot().records;
        const current = records.find((item) => item.id === record.id);
        const currentIds = new Set(
            current && sameTelegram(current)
                ? [
                      ...messagesOf(current),
                      ...(deleteOriginalMedia
                          ? [
                                current.thumbnail,
                                current.thumbnailBlob?.message,
                                current.storyboard?.message,
                            ]
                          : []),
                  ]
                : [],
        );
        const ids = unsharedMessages(
            record,
            records,
            sameTelegram,
            deleteOriginalMedia,
        ).filter(
            (id) =>
                !currentIds.has(id) &&
                (id !== record.thumbnailBlob?.message ||
                    (current &&
                        (!thumbnail ||
                            current.thumbnailBlob?.message === thumbnail.id) &&
                        !records.some(
                            (other) =>
                                other.id !== record.id &&
                                !other.deleted &&
                                [
                                    other.thumbnail,
                                    other.thumbnailBlob?.message,
                                    other.storyboard?.message,
                                    ...messagesOf(other),
                                ].includes(id),
                        ))),
        );
        if (ids.length) await api.deleteMessages(source, ids);
    }
    return uploaded;
}

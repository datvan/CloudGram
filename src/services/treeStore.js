/**
 * The file tree on the server, cut into shards.
 *
 * Every record lives in one shard, picked by a hash of its id. A save sends
 * only the shards that changed, each gzipped and sealed on its own, so the
 * size of one request follows the size of the change, not of the whole tree.
 * The tree used to be one blob that was re-sent whole on every change and
 * eventually outgrew the server's body limit.
 *
 * Each shard's label carries its index, so the server cannot swap one shard
 * in for another. A tree written before sharding (one blob, label
 * "file-tree") is still read, and stays on the server until the first save
 * has written every shard (`dropLegacy`).
 */
import { api } from "./api";
import { decryptJson, encryptJson } from "./crypto";
import { readTreeCache, writeTreeCache } from "./treeCache";

export const SHARD_COUNT = 512;
const LEGACY_LABEL = "file-tree";
// ciphertext per request; a migration of a large tree takes a few requests
const BATCH_BYTES = 8 * 1024 * 1024;

const labelOf = (n) => `file-tree:${n}`;

/** Which shard a record id lives in (FNV-1a). */
export function shardOf(id, count = SHARD_COUNT) {
    let hash = 0x811c9dc5;
    const text = String(id);
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % count;
}

/**
 * The tree, or with `since` only the shards written after that version.
 * `legacy` is true while the server still holds a pre-shard tree.
 */
export async function loadTree(dek, since = 0) {
    const blob = await api.getTree(since);
    return decryptTree(dek, blob);
}

async function decryptTree(dek, blob) {
    if (!blob.version)
        return { version: 0, count: SHARD_COUNT, records: [], legacy: false };
    if (!blob.shards) {
        const tree = await decryptJson(dek, blob, LEGACY_LABEL);
        return {
            version: blob.version,
            count: SHARD_COUNT,
            records: tree.records ?? [],
            legacy: true,
        };
    }
    const parts = await Promise.all(
        Object.entries(blob.shards).map(([n, shard]) =>
            decryptJson(dek, shard, labelOf(n)),
        ),
    );
    if (blob.legacy)
        parts.push(await decryptJson(dek, blob.legacy, LEGACY_LABEL));
    return {
        version: blob.version,
        count: blob.count,
        records: parts.flatMap((tree) => tree.records ?? []),
        legacy: Boolean(blob.legacy),
    };
}

function validCache(value) {
    return (
        value &&
        Number.isSafeInteger(value.version) &&
        value.version > 0 &&
        Number.isSafeInteger(value.count) &&
        value.count > 0 &&
        value.shards &&
        typeof value.shards === "object" &&
        !Array.isArray(value.shards) &&
        Object.entries(value.shards).every(
            ([n, shard]) =>
                /^(0|[1-9]\d*)$/.test(n) &&
                Number(n) < value.count &&
                shard &&
                typeof shard.iv === "string" &&
                typeof shard.ct === "string",
        )
    );
}

export async function loadCachedTree(dek, account) {
    const started = Date.now();
    let cached;
    let hit = false;
    let fetched = 0;
    try {
        cached = await readTreeCache(account);
    } catch {
        // Cache is optional.
    }
    let blob;
    let tree;
    if (validCache(cached)) {
        blob = await api.getTree(cached.version);
        fetched += Object.keys(blob.shards ?? {}).length;
        if (
            blob.shards &&
            !blob.legacy &&
            blob.count === cached.count &&
            blob.version >= cached.version
        ) {
            const combined = {
                version: blob.version,
                count: blob.count,
                shards: { ...cached.shards, ...blob.shards },
            };
            if (validCache(combined)) {
                try {
                    tree = await decryptTree(dek, combined);
                    blob = combined;
                    hit = true;
                } catch {
                    // A stale or damaged cached shard requires a full load.
                }
            }
        }
    }
    if (!tree) {
        blob = await api.getTree(0);
        fetched += Object.keys(blob.shards ?? {}).length;
        tree = await decryptTree(dek, blob);
    }
    if (!blob.legacy && validCache(blob)) {
        try {
            await writeTreeCache(
                account,
                {
                    version: blob.version,
                    count: blob.count,
                    shards: blob.shards,
                },
                { force: cached != null && !hit },
            );
        } catch {
            // Cache is optional.
        }
    }
    return { tree, cache: { hit, shards: fetched, ms: Date.now() - started } };
}

/** Records grouped by shard, for every shard in `wanted` (all when omitted). */
export function groupByShard(records, count, wanted) {
    const groups = new Map();
    for (const n of wanted ?? Array.from({ length: count }, (_, i) => i))
        groups.set(n, []);
    for (const record of records) {
        const group = groups.get(shardOf(record.id, count));
        if (group) group.push(record);
    }
    return groups;
}

/**
 * Write `groups` (shard index → its full record list) on top of `version`.
 * Large writes go in several requests; `onSaved(shards, version)` hears each
 * one the server took, so a failure part way loses nothing already written.
 * Resolves with the new version; a version conflict rejects with ApiError 409.
 */
export async function saveShards(
    dek,
    { version, count },
    groups,
    { dropLegacy = false, onSaved = () => {} } = {},
) {
    const sealed = [];
    for (const [n, records] of groups)
        sealed.push([
            n,
            await encryptJson(dek, { records }, labelOf(n), {
                compress: true,
            }),
        ]);
    const batches = [];
    let batch = [];
    let bytes = 128;
    for (const entry of sealed) {
        const size = JSON.stringify(entry).length + 1;
        if (size + 128 > BATCH_BYTES)
            throw new Error("Tree shard exceeds request limit");
        if (batch.length && bytes + size > BATCH_BYTES) {
            batches.push(batch);
            batch = [];
            bytes = 128;
        }
        batch.push(entry);
        bytes += size;
    }
    if (batch.length || dropLegacy) batches.push(batch);
    for (let i = 0; i < batches.length; i += 1) {
        const last = i === batches.length - 1;
        const res = await api.putTreeShards({
            baseVersion: version,
            count,
            shards: Object.fromEntries(batches[i]),
            // the old blob goes only once every shard holds its records
            ...(dropLegacy && last ? { dropLegacy: true } : {}),
        });
        version = res.version;
        onSaved(
            batches[i].map(([n]) => n),
            version,
        );
    }
    return version;
}

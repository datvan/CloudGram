const groups = [
    "name",
    "thumbData",
    "thumbnailBlob",
    "storyboard",
    "enc",
    "parts",
    "share",
    "labels",
    "other",
];

export function treeStats(records) {
    const totals = {
        records: 0,
        tombstones: 0,
        folders: 0,
        files: 0,
        thumbs: 0,
        recordBytes: 0,
    };
    const maxima = { recordBytes: 0 };
    for (const group of groups) {
        totals[group] = 0;
        maxima[group] = 0;
    }
    const encoder = new TextEncoder();
    const bytes = (value) => {
        const json = JSON.stringify(value);
        return json === undefined ? 0 : encoder.encode(json).length;
    };
    for (const record of records) {
        totals.records++;
        if (record.deleted) totals.tombstones++;
        if (record.type === "folder") totals.folders++;
        if (record.type === "file") totals.files++;
        if (record.thumbData != null) totals.thumbs++;
        const size = bytes(record);
        totals.recordBytes += size;
        maxima.recordBytes = Math.max(maxima.recordBytes, size);
        for (const [key, value] of Object.entries(record)) {
            const group =
                key === "thumbnail"
                    ? "thumbData"
                    : groups.includes(key) && key !== "other"
                    ? key
                    : "other";
            const size = bytes(value);
            totals[group] += size;
            maxima[group] = Math.max(maxima[group], size);
        }
    }
    return { totals, maxima };
}

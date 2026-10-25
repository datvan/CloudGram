/**
 * Turn the flat file list produced by a directory pick or drop into a tree.
 *
 * Every entry carries a relative path such as "photos/2024/a.jpg": a File from
 * a `webkitdirectory` input has it as webkitRelativePath, and a dropped folder
 * is walked into `{ file, path }` pairs. Folders come back parent-before-child, so a caller
 * can create them in order and resolve each tempId to a real record id as it
 * walks the list.
 *
 * Empty folders never show up here: the browser only reports files, so a folder
 * holding nothing is invisible to this API.
 */
export function buildTreeFromPaths(files) {
    const folders = [];
    const tempIdByPath = new Map();
    const entries = [];

    for (const item of files) {
        const file = item instanceof File ? item : item.file;
        const relativePath = item.path || file.webkitRelativePath || file.name;
        const segments = relativePath.split("/").filter(Boolean);
        const name = segments.pop();
        if (!name) continue;

        let parentTempId = null;
        let path = "";
        for (const segment of segments) {
            path = path ? `${path}/${segment}` : segment;
            let tempId = tempIdByPath.get(path);
            if (tempId === undefined) {
                tempId = `tmp-${folders.length}`;
                tempIdByPath.set(path, tempId);
                folders.push({ tempId, name: segment, parentTempId });
            }
            parentTempId = tempId;
        }

        // the handle (pickers.js) and path go to the upload log, for resuming
        entries.push({
            file,
            name,
            parentTempId,
            handle: item.handle,
            path: relativePath,
        });
    }

    return { folders, files: entries };
}

/** Total bytes, for the confirmation shown before a folder upload starts. */
export function totalSize(files) {
    return files.reduce(
        (sum, item) => sum + ((item.file ?? item).size ?? 0),
        0,
    );
}

export function formatSize(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${
        units[unit]
    }`;
}

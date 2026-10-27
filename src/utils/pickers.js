/**
 * Choosing files to upload through the File System Access API where the
 * browser has it (Chrome, Edge), so the upload log can keep a handle to each
 * file and a closed tab can resume with one permission prompt instead of the
 * user picking everything again. Firefox and Safari keep the plain <input>.
 *
 * Every entry is `{ file, path, handle }`, the shape readDrop() produces, with
 * `handle` = { rootId, root, sub }: `root` is what the user picked or dropped
 * (a folder, or a loose file), `sub` the path from it down to the file. A
 * whole folder therefore needs one permission grant, not one per file.
 */
import { v4 as uuid4 } from "uuid";

export const canKeepHandles =
    typeof window !== "undefined" && "showOpenFilePicker" in window;

/** The user closed the picker; not an error worth showing. */
export const isAbort = (error) => error?.name === "AbortError";

// how many files are asked for their details at once while walking a folder
const READ_AHEAD = 64;
// the most often a scan reports how far it got, in ms
const REPORT_EVERY = 100;
// files a scan hands over at a time to start uploading (scanProgress)
const BATCH = 100;

const cancelled = () => new DOMException("Scan cancelled", "AbortError");

/**
 * What a scan of picked or dropped files has read so far, shared by every
 * folder walked for it. `onProgress({ files, bytes })` hears about it at most
 * every 100 ms, and once more at the end (done()); cancel() stops the walk
 * with an AbortError.
 *
 * With `onBatch`, the entries found are also handed over as they come, in
 * groups of BATCH and the rest at done(), so uploading can start long before
 * a folder of thousands is read to the end.
 */
export function scanProgress(onProgress, onBatch) {
    const seen = { files: 0, bytes: 0 };
    let last = 0;
    let stopped = false;
    let batch = [];
    let handed = 0;
    const hand = () => {
        if (!batch.length) return;
        const entries = batch;
        batch = [];
        handed += entries.length;
        onBatch?.(entries);
    };
    return {
        /** How many entries already went to `onBatch`. */
        get handed() {
            return handed;
        },
        /** Forget what was read but not handed over, to read it again. */
        restart() {
            seen.files = 0;
            seen.bytes = 0;
            batch = [];
        },
        add(file) {
            if (stopped) throw cancelled();
            seen.files += 1;
            seen.bytes += file.size;
            const now = performance.now();
            if (now - last >= REPORT_EVERY) {
                last = now;
                onProgress?.({ ...seen });
            }
        },
        found(entry) {
            if (!onBatch) return;
            batch.push(entry);
            if (batch.length >= BATCH) hand();
        },
        check() {
            if (stopped) throw cancelled();
        },
        cancel() {
            stopped = true;
            batch = [];
        },
        done() {
            if (stopped) throw cancelled();
            hand();
            onProgress?.({ ...seen });
        },
    };
}

async function walk(dir, root, rootId, prefix, out, scan) {
    let files = [];
    // read as they are listed, not after the whole folder is: the first
    // files can start uploading while a folder of thousands is still read
    const readFiles = async () => {
        const batch = files;
        files = [];
        // one at a time, a folder of thousands takes long enough to look stuck
        const read = await Promise.all(batch.map(([child]) => child.getFile()));
        batch.forEach(([, sub], j) => {
            const entry = {
                file: read[j],
                path: `${root.name}/${sub}`,
                handle: { rootId, root, sub },
            };
            scan?.add(read[j]);
            scan?.found(entry);
            out.push(entry);
        });
    };
    for await (const child of dir.values()) {
        scan?.check();
        const sub = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.kind === "file") {
            files.push([child, sub]);
            if (files.length >= READ_AHEAD) await readFiles();
        } else await walk(child, root, rootId, sub, out, scan);
    }
    await readFiles();
}

/**
 * Entries under one picked or dropped handle, a file or a folder. `scan`,
 * from scanProgress(), counts what is read.
 */
export async function entriesOf(root, scan) {
    const rootId = uuid4();
    if (root.kind === "file") {
        const file = await root.getFile();
        const entry = {
            file,
            path: root.name,
            handle: { rootId, root, sub: "" },
        };
        scan?.add(file);
        scan?.found(entry);
        return [entry];
    }
    const out = [];
    await walk(root, root, rootId, "", out, scan);
    return out;
}

/**
 * `onPicked` runs once the user has chosen, before anything is read;
 * `scan`, from scanProgress(), counts what is read.
 */
export async function pickFiles({ onPicked, scan } = {}) {
    const handles = await window.showOpenFilePicker({ multiple: true });
    onPicked?.();
    const lists = await Promise.all(handles.map((h) => entriesOf(h, scan)));
    scan?.done();
    return lists.flat();
}

export async function pickFolder({ onPicked, scan } = {}) {
    const root = await window.showDirectoryPicker();
    onPicked?.();
    const entries = await entriesOf(root, scan);
    scan?.done();
    return entries;
}

/**
 * Something that reads the files saved handles point at again. Thousands of
 * files share a few folders, so each folder is looked up once.
 */
export function fileOpener() {
    const dirs = new Map();
    const dirOf = (handle, path) => {
        const key = `${handle.rootId}\n${path.join("/")}`;
        if (!dirs.has(key)) {
            dirs.set(
                key,
                path.length
                    ? dirOf(handle, path.slice(0, -1)).then((parent) =>
                          parent.getDirectoryHandle(path[path.length - 1]),
                      )
                    : Promise.resolve(handle.root),
            );
        }
        return dirs.get(key);
    };
    return async (handle) => {
        if (handle.root.kind === "file") return handle.root.getFile();
        const parts = handle.sub.split("/");
        const name = parts.pop();
        const dir = await dirOf(handle, parts);
        return (await dir.getFileHandle(name)).getFile();
    };
}

/**
 * Ask again for read access to saved handles, one prompt per root. The first
 * request has to start inside the click that asked for it, so they are all
 * started before anything is awaited.
 */
export async function askToRead(roots) {
    const answers = await Promise.all(
        roots.map((root) =>
            root.requestPermission({ mode: "read" }).catch(() => "denied"),
        ),
    );
    return roots.filter((_, i) => answers[i] === "granted");
}

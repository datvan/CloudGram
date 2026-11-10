// Parts of one video cut by the helper (or by hand, with the dialog's
// command) are separate files named "name.part001.mp4", "name.part002.mp4"...
// This finds the ones that belong together, so the player can play them as
// one. No browser or Vite imports, so server/test can load it.
const PART = /^(.*)\.part(\d{2,4})\.([A-Za-z0-9]+)$/;

/**
 * The finished parts in the same folder that run on from `item` without a
 * gap: { chain: records in order, index: where `item` is in it }, or null
 * when `item` is not one of at least two.
 * shortcut: told apart by name only; a renamed part drops out of its video,
 * upgrade by saving the group in the record.
 */
export function partChain(item, siblings) {
    const mine = PART.exec(item.name);
    if (!mine) return null;
    const [, base, digits, ext] = mine;
    const found = new Map();
    for (const s of siblings) {
        const m = PART.exec(s.name);
        if (
            !m ||
            m[1] !== base ||
            m[3].toLowerCase() !== ext.toLowerCase() ||
            (s.parent ?? null) !== (item.parent ?? null) ||
            s.file_id == null ||
            s.trashedAt
        )
            continue;
        if (!found.has(Number(m[2]))) found.set(Number(m[2]), s);
    }
    const at = Number(digits);
    let first = at;
    let last = at;
    while (found.has(first - 1)) first -= 1;
    while (found.has(last + 1)) last += 1;
    if (first === last) return null;
    const chain = [];
    for (let n = first; n <= last; n += 1) chain.push(found.get(n));
    return { chain, index: at - first };
}

/**
 * Names of the `pieces` ({ name, size }) with no finished, not trashed file of
 * that name and size among `records` in `parent`. Empty when all are there.
 * Judged on the records the caller uploaded for this cut, so parts left in the
 * folder by an earlier cut never count.
 */
export function missingPieces(pieces, records, parent) {
    const where = (p) => p ?? null;
    return pieces
        .filter(
            (piece) =>
                !records.some(
                    (r) =>
                        r &&
                        r.type === "file" &&
                        r.name === piece.name &&
                        r.size === piece.size &&
                        where(r.parent) === where(parent) &&
                        r.file_id != null &&
                        !r.trashedAt,
                ),
        )
        .map((piece) => piece.name);
}

/**
 * How many finished, not trashed parts "base.partNNN.ext" of the video `name`
 * already sit in `parent`. Tells the oversize dialog it was cut before.
 * shortcut: by name only, and it does not check the run is complete.
 */
export function partsOf(name, parent, records) {
    const base = name.replace(/\.[^.]+$/, "");
    const numbers = new Set();
    for (const r of records) {
        const m = PART.exec(r.name);
        if (
            m &&
            m[1] === base &&
            (r.parent ?? null) === (parent ?? null) &&
            r.type === "file" &&
            r.file_id != null &&
            !r.trashedAt
        )
            numbers.add(Number(m[2]));
    }
    return numbers.size;
}

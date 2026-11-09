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

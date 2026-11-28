const ACTIVE_TYPES = [
    "QUEUED",
    "UPLOADING",
    "DOWNLOADING",
    "ERROR",
    "REENCRYPT",
];
const FINISHED_KEEP = 200;
const indexes = new WeakMap();

function indexFor(list) {
    let index = indexes.get(list);
    if (!index) {
        index = new Map(list.map((item, i) => [item.id, i]));
        indexes.set(list, index);
    }
    return index;
}

function indexed(list, index) {
    indexes.set(list, index);
    return list;
}

export default function reducer(
    state = {
        activeProgress: [],
        // what the upload panel lists as done, until the user closes it
        finished: [],
    },
    action,
) {
    const index = indexFor(state.activeProgress);
    if (action.type === "REENCRYPT_SKIPPED") {
        const list = state.activeProgress.filter(
            (item) => item.id !== action.id,
        );
        return {
            ...state,
            activeProgress: indexed(
                list,
                new Map(list.map((item, i) => [item.id, i])),
            ),
        };
    }
    if (action.type === "COMPLETED") {
        const entry = state.activeProgress[index.get(action.id)];
        const list = state.activeProgress.filter(
            (item) => item.id !== action.id,
        );
        return {
            ...state,
            activeProgress: indexed(
                list,
                new Map(list.map((item, i) => [item.id, i])),
            ),
            finished: entry
                ? [
                      {
                          id: entry.id,
                          name: entry.name,
                          direction: entry.direction,
                          kept: action.kept,
                          unsaved: action.unsaved,
                      },
                      ...state.finished.filter((item) => item.id !== entry.id),
                  ].slice(0, FINISHED_KEEP)
                : state.finished,
        };
    }

    if (action.type === "KEPT") {
        return {
            ...state,
            finished: [
                {
                    id: action.id,
                    name: action.name,
                    kept: action.kept,
                    unsent: action.unsent,
                },
                ...state.finished.filter((item) => item.id !== action.id),
            ].slice(0, FINISHED_KEEP),
        };
    }

    if (action.type === "CLEAR_FINISHED") {
        return { ...state, finished: [] };
    }

    // many files queued at once (a folder of thousands) arrive as one action,
    // so the page renders once rather than once per file
    if (action.type === "BATCH") {
        const list = [...state.activeProgress];
        let at = index;
        for (const one of action.actions) {
            if (!ACTIVE_TYPES.includes(one.type)) continue;
            const i = at.get(one.id);
            if (i == null) {
                if (at === index) at = new Map(index);
                at.set(one.id, list.length);
                list.push(created(one));
            } else list[i] = updated(list[i], one);
        }
        return { ...state, activeProgress: indexed(list, at) };
    }

    if (!ACTIVE_TYPES.includes(action.type)) return state;

    const i = index.get(action.id);
    if (i == null) {
        const at = new Map(index);
        at.set(action.id, state.activeProgress.length);
        return {
            ...state,
            activeProgress: indexed(
                [...state.activeProgress, created(action)],
                at,
            ),
        };
    }

    const list = state.activeProgress.slice();
    list[i] = updated(list[i], action);
    return {
        ...state,
        activeProgress: indexed(list, index),
    };
}

function fields(action) {
    const entry = {
        id: action.id,
        type: action.type,
        percentage: action.percentage ?? 0,
        message: action.message,
        speed: action.speed,
        status: action.status,
        phase: action.phase,
    };
    // An ERROR entry carries no direction of its own, so remember which way
    // the transfer was going from the entry it replaces.
    if (action.type === "DOWNLOADING") entry.direction = "down";
    if (action.type === "REENCRYPT") entry.direction = "reencrypt";
    if (action.type === "QUEUED" || action.type === "UPLOADING")
        entry.direction = "up";
    return entry;
}

const created = (action) => ({
    direction: "up",
    ...fields(action),
    name: action.name,
});

// `type` has to be overwritten too, or an entry would be stuck on QUEUED
// forever and a retry would stay marked as ERROR. `name` is only sent once,
// when the entry is created, so keep the old one.
function updated(item, action) {
    const entry = fields(action);
    return {
        ...item,
        ...entry,
        direction: entry.direction ?? item.direction,
        name: action.name ?? item.name,
    };
}

/**
 * The active entry for one id. Every file in the drive asks this on every
 * update, so the list is indexed once per change instead of searched by each.
 */
export function activeEntry(state, id) {
    const list = state.progress.activeProgress;
    return list[indexFor(list).get(id)];
}

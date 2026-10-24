const ACTIVE_TYPES = ["QUEUED", "UPLOADING", "DOWNLOADING", "ERROR"];
const FINISHED_KEEP = 200;

export default function reducer(
    state = {
        activeProgress: [],
        // what the upload panel lists as done, until the user closes it
        finished: [],
    },
    action,
) {
    if (action.type === "COMPLETED") {
        const entry = state.activeProgress.find(
            (item) => item.id === action.id,
        );
        return {
            ...state,
            activeProgress: state.activeProgress.filter(
                (item) => item.id !== action.id,
            ),
            finished: entry
                ? [
                      {
                          id: entry.id,
                          name: entry.name,
                          direction: entry.direction,
                      },
                      ...state.finished.filter((item) => item.id !== entry.id),
                  ].slice(0, FINISHED_KEEP)
                : state.finished,
        };
    }

    if (action.type === "CLEAR_FINISHED") {
        return { ...state, finished: [] };
    }

    if (!ACTIVE_TYPES.includes(action.type)) return state;

    const entry = {
        id: action.id,
        type: action.type,
        percentage: action.percentage ?? 0,
        message: action.message,
    };
    // An ERROR entry carries no direction of its own, so remember which way
    // the transfer was going from the entry it replaces.
    if (action.type === "DOWNLOADING") entry.direction = "down";
    if (action.type === "QUEUED" || action.type === "UPLOADING")
        entry.direction = "up";

    if (!state.activeProgress.some((item) => item.id === action.id)) {
        return {
            ...state,
            activeProgress: [
                ...state.activeProgress,
                { direction: "up", ...entry, name: action.name },
            ],
        };
    }

    return {
        ...state,
        activeProgress: state.activeProgress.map((item) => {
            if (item.id !== action.id) return item;
            // `type` has to be overwritten too, or an entry would be stuck on
            // QUEUED forever and a retry would stay marked as ERROR. `name` is
            // only sent once, when the entry is created, so keep the old one.
            return {
                ...item,
                ...entry,
                direction: entry.direction ?? item.direction,
                name: action.name ?? item.name,
            };
        }),
    };
}

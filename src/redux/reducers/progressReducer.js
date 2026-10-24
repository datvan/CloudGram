const ACTIVE_TYPES = ["QUEUED", "UPLOADING", "DOWNLOADING", "ERROR"];

export default function reducer(
    state = {
        activeProgress: [],
    },
    action,
) {
    if (action.type === "COMPLETED") {
        return {
            ...state,
            activeProgress: state.activeProgress.filter(
                (item) => item.id !== action.id,
            ),
        };
    }

    if (!ACTIVE_TYPES.includes(action.type)) return state;

    const entry = {
        id: action.id,
        type: action.type,
        percentage: action.percentage ?? 0,
        message: action.message,
    };

    if (!state.activeProgress.some((item) => item.id === action.id)) {
        return {
            ...state,
            activeProgress: [
                ...state.activeProgress,
                { ...entry, name: action.name },
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
            return { ...item, ...entry, name: action.name ?? item.name };
        }),
    };
}

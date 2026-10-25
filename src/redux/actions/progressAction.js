export function queuedProgress(id, name) {
    return {
        id: id,
        name: name,
        percentage: 0,
        type: "QUEUED",
    };
}

// back in line after a failed attempt; `message` says when it goes again
export function retryingProgress(id, message) {
    return {
        id: id,
        message: message,
        percentage: 0,
        type: "QUEUED",
    };
}

// `speed` is in bytes a second, once there is enough to tell
export function uploadProgress(id, percentage, speed) {
    return {
        id: id,
        percentage: Math.min(percentage, 100),
        speed: speed,
        type: "UPLOADING",
    };
}

export function downloadProgress(id, percentage) {
    return {
        id: id,
        percentage: Math.min(percentage, 100),
        type: "DOWNLOADING",
    };
}

export function errorProgress(id, message) {
    return {
        id: id,
        message: message,
        type: "ERROR",
    };
}

// Reaching 100% used to clear the entry on its own, which hid the gap between
// the last byte leaving and the record getting its file_id. Whoever started the
// transfer now says when it is done.
export function completedProgress(id) {
    return {
        id: id,
        type: "COMPLETED",
    };
}

/** Several of the actions above as one update. */
export function batchProgress(actions) {
    return {
        type: "BATCH",
        actions: actions,
    };
}

export function clearFinished() {
    return {
        type: "CLEAR_FINISHED",
    };
}

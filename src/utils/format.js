export { formatSize } from "./buildTreeFromPaths";

/** Drive's style: the time for today, the day for this year, else the full date. */
export function formatDate(ms) {
    if (!ms) return "—";
    const date = new Date(ms);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString("vi-VN", {
            hour: "2-digit",
            minute: "2-digit",
        });
    }
    if (date.getFullYear() === now.getFullYear()) {
        return date.toLocaleDateString("vi-VN", {
            day: "numeric",
            month: "short",
        });
    }
    return date.toLocaleDateString("vi-VN", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export function formatDateTime(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleString("vi-VN", {
        dateStyle: "medium",
        timeStyle: "short",
    });
}

/** Case- and accent-insensitive, so "tai lieu" finds "Tài liệu". */
export function fold(text) {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D")
        .toLowerCase();
}

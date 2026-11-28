const keys = ["name", "updatedAt", "size"];
const directions = ["asc", "desc"];

export function parseSort(value) {
    try {
        const sort = JSON.parse(value);
        if (sort && keys.includes(sort.key) && directions.includes(sort.dir)) {
            return { key: sort.key, dir: sort.dir };
        }
    } catch {
        // Invalid preferences use the default.
    }
    return { key: "name", dir: "asc" };
}

export function nextSort(sort, field, value) {
    return { ...sort, [field]: value };
}

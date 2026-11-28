import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import vm from "node:vm";

test("offline bulk upload benchmark", async () => {
    const [tree, driveSource, progressSource] = await Promise.all(
        [
            "../../src/services/treeStore.js",
            "../../src/services/drive.js",
            "../../src/redux/reducers/progressReducer.js",
        ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
    const strip = (source) =>
        source
            .replace(/^import [\s\S]*?;\r?\n/gm, "")
            .replace(/\bexport /g, "");
    const driveCode =
        strip(
            tree.replace(
                "export async function saveShards(",
                "async function unusedSaveShards(",
            ),
        ) +
        "\n" +
        strip(driveSource.replace(/\r\n/g, "\n"))
            .replace(
                "const cutoff = Date.now() - TOMBSTONE_TTL;",
                "const benchStart = performance.now();\n            const cutoff = Date.now() - TOMBSTONE_TTL;",
            )
            .replace(
                "            try {\n                await saveShards",
                "            selectionMs = performance.now() - benchStart;\n            try {\n                await saveShards",
            );
    const reducerCode = strip(
        progressSource.replace(
            "export default function reducer",
            "function reducer",
        ),
    );
    const rows = [];

    for (const n of process.env.CG_BENCH === "1" ? [1000, 10000] : [1000]) {
        let selectionMs = 0;
        let selected;
        const context = vm.createContext({
            performance,
            set selectionMs(value) {
                selectionMs = value;
            },
            api: { getTree: async () => ({ version: 0 }) },
            ApiError: class extends Error {},
            uuid4: () => {
                throw new Error("Explicit IDs required");
            },
            diag() {},
            swallow: () => () => {},
            setTimeout: () => 0,
            clearTimeout() {},
            saveShards: async (_key, { version }, groups, { onSaved }) => {
                selected = groups;
                onSaved([...groups.keys()], version + 1);
            },
        });
        const drive = vm.runInContext(
            `${driveCode}\n;({openDrive, createFolder, createFile, update, flush, getSnapshot})`,
            context,
        );
        const progress = vm.runInContext(
            `${reducerCode}\n;({reducer, activeEntry})`,
            context,
        );
        await drive.openDrive({});
        for (let i = 0; i < 300; i++)
            drive.createFolder(`folder ${i}`, null, { id: `folder-${i}` });

        let start = performance.now();
        for (let i = 0; i < n; i++)
            drive.createFile({
                id: `file-${i}`,
                name: `file ${i}`,
                parent: `folder-${i % 300}`,
                size: 1,
                mime: "text/plain",
            });
        const createMs = performance.now() - start;
        assert.equal(drive.getSnapshot().records.length, n + 300);

        let state = {
            activeProgress: Array.from({ length: n }, (_, i) => ({
                id: `file-${i}`,
                name: `file ${i}`,
                type: "QUEUED",
            })),
            finished: [],
        };
        let found = 0;
        start = performance.now();
        for (let tick = 0; tick < 100; tick++) {
            state = progress.reducer(state, {
                type: "UPLOADING",
                id: `file-${tick % n}`,
                percentage: tick,
            });
            const root = { progress: state };
            for (let i = 0; i < n; i++)
                if (progress.activeEntry(root, `file-${i}`)) found++;
        }
        const progressMs = performance.now() - start;
        assert.equal(state.activeProgress.length, n);
        assert.equal(found, n * 100);

        await drive.flush();
        assert.equal(
            [...selected.values()].reduce(
                (sum, group) => sum + group.length,
                0,
            ),
            n + 300,
        );
        drive.update("file-0", { name: "changed" });
        await drive.flush();
        assert.equal(selected.size, 1);
        assert.equal(
            [...selected.values()][0].filter((record) => record.id === "file-0")
                .length,
            1,
        );
        rows.push({
            N: n,
            "create ms": createMs.toFixed(2),
            "100 ticks ms": progressMs.toFixed(2),
            "selection ms": selectionMs.toFixed(2),
        });
    }
    console.log("Bulk upload benchmark (offline)");
    console.table(rows);
});

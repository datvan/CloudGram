function records(input) {
    const found = [];
    let skipped = 0;
    function add(value) {
        if (typeof value === "string") {
            if (!value.trim()) return;
            try {
                add(JSON.parse(value));
            } catch {
                skipped++;
            }
        } else if (Array.isArray(value)) value.forEach(add);
        else if (value && typeof value === "object") {
            const event =
                value.src === "client" ? value.ev : value.evt ? value : null;
            const ts = event ? event.ts : value.ts;
            if (
                Number.isFinite(ts) &&
                ((event && typeof event.evt === "string") ||
                    value.src === "api")
            )
                found.push({ value, event, ts });
            else skipped++;
        } else skipped++;
    }
    input.forEach(add);
    return { found, skipped };
}

const hidden = [
    "evt",
    "ts",
    "t",
    "tab",
    "build",
    "br",
    "fsa",
    "uploadOwner",
    "logOwner",
    "seq",
];
const fields = (data, excluded) =>
    Object.entries(data)
        .filter(([key]) => !excluded.includes(key))
        .map(
            ([key, val]) =>
                `${key}=${typeof val === "object" ? JSON.stringify(val) : val}`,
        )
        .join(" ");
const bySequence = (a, b) => {
    const x = a.event.seq,
        y = b.event.seq;
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y || a.ts - b.ts;
    if (Number.isFinite(x)) return -1;
    if (Number.isFinite(y)) return 1;
    return a.ts - b.ts;
};

export function formatLogs(input, options = {}) {
    const { found, skipped } = records(input);
    const clients = found.filter(({ event }) => event);
    const matching = clients.filter(
        ({ event }) =>
            (!options.tab || event.tab === options.tab) &&
            (!options.run || event.run === options.run),
    );
    const isError = ({ event, value }) =>
        event
            ? event.evt.startsWith("err.")
            : value.lvl === "error" || value.status >= 500;
    const tabs = new Map();
    for (const item of matching) {
        const tab = item.event.tab || "(no tab)";
        if (!tabs.has(tab)) tabs.set(tab, []);
        tabs.get(tab).push(item);
    }
    const server = found
        .filter((item) => !item.event)
        .sort((a, b) => a.ts - b.ts);
    const base = matching.length
        ? Math.min(...matching.map(({ ts }) => ts))
        : (server[0]?.ts ?? 0);
    const offset = (ts) =>
        `${ts < base ? "-" : "+"}${(Math.abs(ts - base) / 1000).toFixed(3)}s`;
    const lines = [];
    let runCount = 0,
        finished = 0,
        stalled = 0;
    const errors = {};
    for (const { event } of matching)
        if (event.evt.startsWith("err."))
            errors[event.evt] = (errors[event.evt] || 0) + 1;
    for (const [tab, items] of tabs) {
        items.sort(bySequence);
        const allTab = clients
            .filter(({ event }) => (event.tab || "(no tab)") === tab)
            .sort(bySequence);
        const tabLast = allTab.at(-1);
        const runs = new Map();
        for (const item of items)
            if (item.event.run) {
                if (!runs.has(item.event.run)) runs.set(item.event.run, []);
                runs.get(item.event.run).push(item);
            }
        runCount += runs.size;
        finished += [...runs.values()].filter((run) =>
            run.some(({ event }) => event.evt === "run.finish"),
        ).length;
        stalled += [...runs.values()].filter((run) =>
            run.some(({ event }) => event.evt === "run.stall"),
        ).length;
        const shown = items.filter((item) => !options.errors || isError(item));
        let previous, header;
        const context = {
            acct: items.find(({ value }) => value.acct !== undefined)?.value
                .acct,
        };
        for (const item of shown) {
            const { event, value, ts } = item;
            for (const key of ["build", "br", "fsa", "uploadOwner", "logOwner"])
                if (event[key] !== undefined) context[key] = event[key];
            if (value.acct !== undefined) context.acct = value.acct;
            const nextHeader = `tab ${tab}  build ${context.build ?? "-"}  ${context.br ?? "-"}  fsa=${context.fsa ?? "-"}  acct ${context.acct ?? "-"}  owner flags: upload=${context.uploadOwner ?? "-"} log=${context.logOwner ?? "-"}`;
            if (header !== nextHeader) {
                lines.push(nextHeader);
                header = nextHeader;
            }
            const seq = event.seq;
            if (Number.isSafeInteger(seq) && seq > 0) {
                if (previous === undefined && seq > 1)
                    lines.push(`  … first ${seq - 1} events not received`);
                else if (previous !== undefined && seq > previous + 1)
                    lines.push(
                        `  … ${seq - previous - 1} events missing (seq ${previous + 1}-${seq - 1}: lost, dropped by the filter, or still in flight)`,
                    );
                previous = Math.max(previous ?? 0, seq);
            }
            const extra = fields(event, options.verbose ? ["evt"] : hidden);
            lines.push(
                `  ${offset(ts)}  ${event.evt === "diag.lost" ? "!! " : ""}${event.evt}${extra ? `  ${extra}` : ""}`,
            );
        }
        for (const [run, runItems] of runs) {
            if (options.errors && !runItems.some(isError)) continue;
            const last = runItems.at(-1);
            const elapsed =
                Number.isFinite(tabLast.event.t) &&
                Number.isFinite(last.event.t)
                    ? tabLast.event.t - last.event.t
                    : tabLast.ts - last.ts;
            lines.push(`  run ${run}`);
            lines.push(
                `  LAST STAGE REACHED: ${last.event.evt} ${(elapsed / 1000).toFixed(3)}s before the last event of this tab`,
            );
            if (!runItems.some(({ event }) => event.evt === "run.finish"))
                lines.push(`  NO run.finish: stopped after ${last.event.evt}`);
            lines.push(
                `  SUMMARY: file.done=${runItems.filter(({ event }) => event.evt === "file.done").length} file.fail=${runItems.filter(({ event }) => event.evt === "file.fail").length} err.swallowed=${runItems.filter(({ event }) => event.evt === "err.swallowed").length}`,
            );
        }
    }
    const shownServer = server.filter(
        (item) => !options.errors || isError(item),
    );
    if (shownServer.length) {
        lines.push("server");
        for (const { value, ts } of shownServer) {
            const keys = options.verbose
                ? Object.keys(value).filter((key) => key !== "stack")
                : ["route", "status", "ms", "code", "errName", "errCode"];
            const data = Object.fromEntries(
                keys
                    .filter((key) => value[key] !== undefined)
                    .map((key) => [key, value[key]]),
            );
            lines.push(
                `  ${offset(ts)}  ${value.status >= 400 && value.status < 600 ? "!! " : ""}${value.lvl === "error" ? "error" : "access"}  ${fields(data, [])}`.trimEnd(),
            );
            if (Array.isArray(value.stack))
                for (const frame of value.stack) lines.push(`    ${frame}`);
        }
    }
    lines.push(
        `SUMMARY: tabs=${tabs.size} runs=${runCount} run.finish=${finished} run.stall=${stalled} err.*=${
            Object.entries(errors)
                .map(([key, n]) => `${key}:${n}`)
                .join(",") || "0"
        } api.5xx=${server.filter(({ value }) => value.status >= 500 && value.status < 600).length} skipped=${skipped}`,
    );
    return lines.join("\n");
}

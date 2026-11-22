import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatLogs } from "./log-formatter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(args) {
    const options = { since: "30 min ago" };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (["--errors", "--raw", "--verbose"].includes(arg))
            options[arg.slice(2)] = true;
        else if (
            ["--since", "--tab", "--run", "--file"].includes(arg) &&
            args[i + 1] &&
            !args[i + 1].startsWith("--")
        )
            options[arg.slice(2)] = args[++i];
        else throw new Error("Invalid arguments");
    }
    if (!/^[A-Za-z0-9 :.+-]{1,80}$/.test(options.since))
        throw new Error("Invalid --since");
    return options;
}

async function hostFromEnv(env, base) {
    if (env.DEPLOY_HOST) return env.DEPLOY_HOST;
    for (const filename of [
        path.join(base, ".env"),
        path.resolve(base, "../../../.env"),
    ]) {
        let contents;
        try {
            contents = await readFile(filename, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") continue;
            throw new Error("Cannot read .env");
        }
        const match = contents.match(/^[ \t]*DEPLOY_HOST[ \t]*=[ \t]*(.*)$/m);
        return match ? match[1].replace(/["' \r]/g, "") : "";
    }
    return "";
}

function runSsh(host, since) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "ssh",
            [
                "-o",
                "BatchMode=yes",
                host,
                "journalctl",
                "-u",
                "cloudgram-api",
                "-o",
                "cat",
                "--no-pager",
                "--since",
                `'${since}'`,
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
        );
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            output += chunk;
        });
        child.on("error", () => reject({ code: null }));
        child.on("close", (code) =>
            code === 0 ? resolve(output) : reject({ code }),
        );
    });
}

export async function main(
    args,
    {
        env = process.env,
        base = root,
        runner = runSsh,
        stdin = process.stdin,
        stdout = process.stdout,
        stderr = process.stderr,
    } = {},
) {
    try {
        const options = parseArgs(args);
        let data;
        if (options.file === "-") {
            data = "";
            for await (const chunk of stdin) data += chunk;
        } else if (options.file)
            data = await readFile(options.file, "utf8").catch(() => {
                throw new Error("Cannot read input file");
            });
        else {
            const host = await hostFromEnv(env, base);
            if (!host || /^-|\s/.test(host))
                throw new Error("Invalid or missing DEPLOY_HOST");
            data = await runner(host, options.since).catch((error) => {
                throw new Error(
                    `SSH failed (exit code ${Number.isInteger(error?.code) ? error.code : "unavailable"})`,
                );
            });
        }
        if (options.raw) stdout.write(data);
        else {
            let input;
            try {
                const parsed = JSON.parse(data);
                input = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
                input = data.split(/\r?\n/);
            }
            stdout.write(`${formatLogs(input, options)}\n`);
        }
        return 0;
    } catch (error) {
        stderr.write(`${error.message}\n`);
        return 1;
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    process.exitCode = await main(process.argv.slice(2));

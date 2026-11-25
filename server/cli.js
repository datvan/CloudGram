#!/usr/bin/env node
/**
 * Account administration, run on the VPS as the service user:
 *
 *     cloudgram-admin add <username>     create an account, print its setup link
 *     cloudgram-admin reset <username>   new setup link; wipes the vault (the old
 *                                        password sealed it, so it is unreadable)
 *     cloudgram-admin delete <username>
 *     cloudgram-admin list
 *
 * Restart the service after a change: it keeps db.json in memory and would
 * otherwise write its stale copy back over this one.
 */
import { CloudGramApi } from "./app.js";
import { Db } from "./db.js";
import { SharedTelegram } from "./shared-telegram.js";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const [command, username] = process.argv.slice(2);
const site = process.env.CLOUDGRAM_ORIGIN ?? "https://cloudgram.example.com";
const db = await new Db(
    process.env.CLOUDGRAM_DATA ?? "/var/lib/cloudgram-api",
).open();
const api = new CloudGramApi({ db, pepper: process.env.CLOUDGRAM_PEPPER });
const telegram = new SharedTelegram(db.dir);

switch (command) {
    case "telegram-link": {
        telegram.key();
        const client = await telegram.client("");
        const input = createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        const hidden = new Writable({
            write(_chunk, _encoding, callback) {
                callback();
            },
        });
        try {
            await client.start({
                phoneNumber: () =>
                    input.question("Phone (international format): "),
                phoneCode: () => input.question("Telegram code: "),
                password: async () => {
                    input.close();
                    process.stdout.write("Telegram 2FA password: ");
                    const secret = createInterface({
                        input: process.stdin,
                        output: hidden,
                        terminal: true,
                    });
                    try {
                        return await secret.question("");
                    } finally {
                        secret.close();
                        process.stdout.write("\n");
                    }
                },
                onError: (error) => {
                    throw error;
                },
            });
            await telegram.save(client.session.save());
            console.log("Telegram linked.");
        } finally {
            input.close();
            await client.destroy();
        }
        break;
    }
    case "telegram-status":
        console.log(
            (await telegram.load())
                ? "Telegram linked."
                : "Telegram not linked.",
        );
        break;
    case "telegram-unlink":
        await telegram.unlink();
        console.log(
            "Telegram unlinked locally. Existing Telegram sessions remain active.",
        );
        break;
    case "add":
    case "reset": {
        const token = await api.issueSetup(username, {
            reset: command === "reset",
        });
        console.log(
            `Setup link (valid 7 days, single use):\n${site}/setup#${token}`,
        );
        break;
    }
    case "delete":
        await api.deleteUser(username);
        console.log(`deleted ${username}`);
        break;
    case "list":
        console.table(api.listUsers());
        break;
    default:
        console.log(
            "usage: cloudgram-admin add|reset|delete <username> | list",
        );
        process.exit(1);
}

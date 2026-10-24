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

const [command, username] = process.argv.slice(2);
const site = process.env.CLOUDGRAM_ORIGIN ?? "https://cloudgram.datvan.com";
const db = await new Db(
    process.env.CLOUDGRAM_DATA ?? "/var/lib/cloudgram-api",
).open();
const api = new CloudGramApi({ db, pepper: process.env.CLOUDGRAM_PEPPER });

switch (command) {
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

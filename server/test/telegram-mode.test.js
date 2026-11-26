import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function setup(admin = true) {
    const source = (
        await readFile(
            new URL("../../src/services/account.js", import.meta.url),
            "utf8",
        )
    )
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    let vault = null;
    const client = {
        connect: async () => {},
        isUserAuthorized: async () => true,
        getMe: async () => ({}),
    };
    const context = vm.createContext({
        console,
        onClientChange() {},
        Store: { dispatch() {} },
        setAuth: (state) => state,
        api: {
            getSession: async () => {
                if (!admin) throw new Error("admin_only");
                return { session: vault };
            },
            putSession: async (blob) => {
                vault = blob;
            },
            deleteSession: async () => {
                vault = null;
            },
        },
        encryptJson: async (_key, value) => JSON.stringify(value),
        decryptJson: async (_key, value) => JSON.parse(value),
        sessionString: () => "session-text",
        browserId: () => "browser",
        clearLegacySession() {},
        legacySession: async () => "legacy-text",
        newClient: () => client,
        setClient() {},
        hasClient: () => false,
        stopClient: async () => {},
    });
    const account = vm.runInContext(
        `${source}\naccount = { admin: ${admin} }; ({ adoptTelegram, adoptLegacySession, getTelegramMode, unlinkTelegram })`,
        context,
    );
    return {
        account,
        client,
        setVault: (value) => {
            vault = value;
        },
        getVault: () => vault,
    };
}

test("non-admin mode matches proxy upload records without requesting a vault session", async () => {
    const { account } = await setup(false);
    assert.equal(await account.getTelegramMode(), "private");
});

test("shared and manual link save their mode in the encrypted session", async () => {
    const { account, client, getVault } = await setup();
    await account.adoptTelegram(client, "shared");
    assert.deepEqual(JSON.parse(getVault()), {
        session: "session-text",
        telegramMode: "shared",
    });
    assert.equal(await account.getTelegramMode(), "shared");
    await account.adoptTelegram(client);
    assert.deepEqual(JSON.parse(getVault()), {
        session: "session-text",
        telegramMode: "private",
    });
    assert.equal(await account.getTelegramMode(), "private");
});

test("legacy adoption saves private; old vault defaults to private; unlink clears mode", async () => {
    const { account, setVault, getVault } = await setup();
    assert.equal(await account.getTelegramMode(), null);
    setVault(JSON.stringify({ session: "old-session" }));
    assert.equal(await account.getTelegramMode(), "private");
    await account.adoptLegacySession();
    assert.deepEqual(JSON.parse(getVault()), {
        session: "session-text",
        telegramMode: "private",
    });
    await account.unlinkTelegram();
    assert.equal(await account.getTelegramMode(), null);
});

test("link UI passes shared only for automatic login", async () => {
    const source = await readFile(
        new URL("../../src/pages/auth/TelegramLink.jsx", import.meta.url),
        "utf8",
    );
    assert.match(
        source,
        /const client = await openSharedClient\([\s\S]*?\);[\s\S]*?await adoptTelegram\(client, "shared"\);/,
    );
    assert.match(
        source,
        /async function finish\(\)[\s\S]*?await adoptTelegram\(client\);/,
    );
    assert.match(source, /await adoptLegacySession\(\);/);
});

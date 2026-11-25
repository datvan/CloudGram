import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function load(path, exports, context = {}) {
    const source = (await readFile(new URL(path, import.meta.url), "utf8"))
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    return vm.runInNewContext(`${source}\n;(${exports})`, context);
}

test("opens a separate shared client without changing the current client", async () => {
    const current = {};
    let active = current;
    const client = { connect: async () => {}, destroy: async () => {} };
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
        { setClient: (value) => (active = value) },
    );
    const result = await openSharedClient({
        deps: {
            newClient: (session) => {
                assert.equal(session, "");
                return client;
            },
            sharedLogin: async (value) => assert.equal(value, client),
        },
    });
    assert.equal(result, client);
    assert.equal(active, current);
});

test("destroys client on connect or login failure and preserves error", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
    );
    for (const stage of ["connect", "login"]) {
        const failure = new Error(stage);
        let destroyed = false;
        const client = {
            connect: async () => {
                if (stage === "connect") throw failure;
            },
            destroy: async () => {
                destroyed = true;
            },
        };
        await assert.rejects(
            openSharedClient({
                deps: {
                    newClient: () => client,
                    sharedLogin: async () => {
                        if (stage === "login") throw failure;
                    },
                },
            }),
            (error) => error === failure,
        );
        assert.equal(destroyed, true);
    }
});

test("maps 503 telegram_not_linked after destroying client", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
    );
    let destroyed = false;
    await assert.rejects(
        openSharedClient({
            deps: {
                newClient: () => ({
                    connect: async () => {},
                    destroy: async () => {
                        destroyed = true;
                    },
                }),
                sharedLogin: async () => {
                    throw { status: 503, code: "telegram_not_linked" };
                },
            },
        }),
        (error) =>
            error.code === "telegram_not_linked" && error.name === "Error",
    );
    assert.equal(destroyed, true);
});

test("saving shared session seals vault without adopting client", async () => {
    let vault;
    let adopted = false;
    const { saveSharedSession } = await load(
        "../../src/services/account.js",
        "{ saveSharedSession }",
        {
            onClientChange() {},
            encryptJson: async (_key, value) => JSON.stringify(value),
            sessionString: (client) => client.session,
            api: {
                putSession: async (blob) => {
                    vault = blob;
                },
            },
            browserId: () => "browser",
            setClient: () => {
                adopted = true;
            },
        },
    );
    await saveSharedSession({ session: "shared-session" });
    assert.deepEqual(JSON.parse(vault), {
        session: "shared-session",
        telegramMode: "shared",
    });
    assert.equal(adopted, false);
});

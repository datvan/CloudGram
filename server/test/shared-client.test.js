import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function load(path, exports, context = {}) {
    const source = (await readFile(new URL(path, import.meta.url), "utf8"))
        .replace(/^import [\s\S]*?;\r?\n/gm, "")
        .replace(/\bexport /g, "");
    return vm.runInNewContext(`${source}\n;(${exports})`, {
        Api: { auth: { LogOut: class LogOut {} } },
        setTimeout,
        clearTimeout,
        ...context,
    });
}

function fakeClient(fail) {
    const state = { destroyed: 0, dc: null, events: [] };
    const client = {
        session: { dcId: 2, setDC: (...args) => (state.dc = args) },
        getDC: async (...args) => {
            assert.deepEqual(args, [2, false, true]);
            return { ipAddress: "venus.web.telegram.org", port: 443 };
        },
        connect: async () => {
            if (fail === "connect") throw new Error(fail);
        },
        getMe: async () => {
            if (fail === "getMe") throw new Error(fail);
            return {};
        },
        invoke: async (request) => {
            assert.equal(request.constructor.name, "LogOut");
            state.events.push("logout");
        },
        destroy: async () => {
            state.destroyed++;
            state.events.push("destroy");
        },
    };
    return { client, state };
}

test("opens and verifies server session with browser DC without adopting", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
    );
    const { client, state } = fakeClient();
    const result = await openSharedClient({
        deps: {
            issueTelegramSession: async () => ({ session: "issued", dcId: 2 }),
            newClient: (session) => {
                assert.equal(session, "issued");
                return client;
            },
        },
    });
    assert.equal(result, client);
    assert.deepEqual(state.dc, [2, "venus.web.telegram.org", 443]);
    assert.equal(state.destroyed, 0);
    assert.deepEqual(state.events, []);
});

test("connect and getMe failures destroy client and preserve error", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
    );
    for (const stage of ["connect", "getMe"]) {
        const { client, state } = fakeClient(stage);
        await assert.rejects(
            openSharedClient({
                deps: {
                    issueTelegramSession: async () => ({
                        session: "issued",
                        dcId: 2,
                    }),
                    newClient: () => client,
                },
            }),
            { message: stage },
        );
        assert.equal(state.destroyed, 1);
        assert.deepEqual(state.events, ["logout", "destroy"]);
    }
});

test("API errors preserve codes and have Vietnamese messages", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
    );
    const { ApiError, describeError, api } = await load(
        "../../src/services/api.js",
        "{ ApiError, describeError, api }",
        {
            fetch: async (path, options) => {
                assert.equal(path, "/api/tg/session");
                assert.equal(options.method, "POST");
                return {
                    ok: true,
                    json: async () => ({ session: "issued", dcId: 2 }),
                };
            },
        },
    );
    assert.equal((await api.issueTelegramSession()).session, "issued");
    for (const code of [
        "telegram_password_missing",
        "telegram_password_invalid",
        "telegram_busy",
        "telegram_not_linked",
    ]) {
        const error = new ApiError(503, code);
        assert.ok(!describeError(error).includes(code));
        await assert.rejects(
            openSharedClient({
                deps: {
                    issueTelegramSession: async () => {
                        throw error;
                    },
                    newClient: () => assert.fail("client must not be created"),
                },
            }),
            (actual) => actual === error,
        );
    }
});

test("cancellation during verification destroys client and prevents return", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
    );
    const { client, state } = fakeClient();
    const controller = new AbortController();
    client.getMe = async () => {
        controller.abort();
        return {};
    };
    await assert.rejects(
        openSharedClient({
            signal: controller.signal,
            deps: {
                issueTelegramSession: async () => ({
                    session: "issued",
                    dcId: 2,
                }),
                newClient: () => client,
            },
        }),
        { name: "AbortError" },
    );
    assert.deepEqual(state.events, ["logout", "destroy"]);
});

test("abort while receiving session logs out issued client", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
    );
    const { client, state } = fakeClient();
    const controller = new AbortController();
    await assert.rejects(
        openSharedClient({
            signal: controller.signal,
            deps: {
                issueTelegramSession: async () => {
                    controller.abort();
                    return { session: "issued", dcId: 2 };
                },
                newClient: () => client,
            },
        }),
        { name: "AbortError" },
    );
    assert.deepEqual(state.events, ["logout", "destroy"]);
});

test("logout failure or timeout preserves original error and destroys client", async () => {
    const { openSharedClient } = await load(
        "../../src/services/telegramAuth.js",
        "{ openSharedClient }",
        {
            setTimeout: (callback) => setTimeout(callback, 0),
        },
    );
    for (const mode of ["throw", "hang"]) {
        const { client, state } = fakeClient("getMe");
        client.invoke = () => {
            state.events.push("logout");
            if (mode === "throw") throw new Error("logout failed");
            return new Promise(() => {});
        };
        await assert.rejects(
            openSharedClient({
                deps: {
                    issueTelegramSession: async () => ({
                        session: "issued",
                        dcId: 2,
                    }),
                    newClient: () => client,
                },
            }),
            { message: "getMe" },
        );
        assert.deepEqual(state.events, ["logout", "destroy"]);
    }
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedTelegram } from "../shared-telegram.js";

const type = () =>
    class {
        constructor(fields = {}) {
            Object.assign(this, fields);
        }
    };
const Api = {
    auth: Object.fromEntries(
        [
            "ExportLoginToken",
            "AcceptLoginToken",
            "ImportLoginToken",
            "LoginToken",
            "LoginTokenMigrateTo",
            "LoginTokenSuccess",
            "CheckPassword",
            "LogOut",
        ].map((name) => [name, type()]),
    ),
    account: { GetPassword: type() },
};
const sdkError = (errorMessage, extra = {}) =>
    Object.assign(new Error("password-secret session-secret token-secret"), {
        errorMessage,
        ...extra,
    });

async function fixture(options = {}) {
    const dir = await mkdtemp(join(tmpdir(), "cg-issue-"));
    const shared = new SharedTelegram(dir, {
        CLOUDGRAM_TG_ROOT_KEY: randomBytes(32).toString("base64"),
        CLOUDGRAM_TG_API_ID: "42",
        CLOUDGRAM_TG_API_HASH: "hash",
    });
    const calls = [];
    shared.telegramApi = async () => Api;
    shared.passwordCheck = async (parameters, password) => {
        calls.push(["compute", parameters, password]);
        return "check";
    };
    shared.client = async (session) => {
        const root = Boolean(session);
        let exports = 0;
        const client = {
            session: {
                dcId: 1,
                save() {
                    if (!root && options.saveError) throw sdkError("FAIL");
                    return root ? "updated-root" : "new-session";
                },
            },
            async connect() {
                calls.push([root ? "root-connect" : "connect"]);
            },
            async destroy() {
                calls.push([root ? "root-destroy" : "destroy"]);
            },
            async _switchDC(dcId) {
                calls.push(["switch", dcId]);
                this.session.dcId = dcId;
            },
            async invoke(request) {
                const name = Object.entries({
                    ...Api.auth,
                    ...Api.account,
                }).find(([, C]) => request instanceof C)?.[0];
                calls.push([name, client, request]);
                if (name === "ExportLoginToken") {
                    if (options.flood)
                        throw sdkError(options.flood, {
                            seconds: options.floodSeconds ?? 17,
                        });
                    if (++exports === 1)
                        return new Api.auth.LoginToken({
                            token: Buffer.from("token-secret"),
                        });
                    if (options.password && !options.migrateBeforePassword)
                        throw sdkError("SESSION_PASSWORD_NEEDED");
                    return options.migrate
                        ? new Api.auth.LoginTokenMigrateTo({
                              dcId: 4,
                              token: Buffer.from("token-secret"),
                          })
                        : new Api.auth.LoginTokenSuccess();
                }
                if (name === "ImportLoginToken") {
                    if (options.password && options.migrateBeforePassword)
                        throw sdkError("SESSION_PASSWORD_NEEDED");
                    return new Api.auth.LoginTokenSuccess();
                }
                if (name === "GetPassword") return { srp: "parameters" };
                if (name === "CheckPassword") {
                    if (options.passwordFlood)
                        throw sdkError("FLOOD", { seconds: 30 });
                    if (options.wrong) throw sdkError("PASSWORD_HASH_INVALID");
                    if (options.migrateAfterPassword)
                        return new Api.auth.LoginTokenMigrateTo({
                            dcId: 4,
                            token: Buffer.from("token-secret"),
                        });
                    return {};
                }
            },
        };
        return client;
    };
    if (!options.unlinked) await shared.save("root-session");
    return {
        dir,
        shared,
        calls,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    };
}

test("password encryption, fresh IV, clearing and validation", async () => {
    const f = await fixture();
    try {
        assert.equal(await f.shared.loadPassword(), null);
        await assert.rejects(f.shared.savePassword(""));
        await f.shared.savePassword("password-secret");
        const first = await readFile(f.shared.passwordFile, "utf8");
        assert.equal(first.includes("password-secret"), false);
        assert.deepEqual(await f.shared.loadPassword(), {
            password: "password-secret",
            invalid: false,
        });
        if (process.platform !== "win32")
            assert.equal(
                (await stat(f.shared.passwordFile)).mode & 0o777,
                0o600,
            );
        await f.shared.savePassword("password-secret");
        assert.notEqual(
            JSON.parse(first).iv,
            JSON.parse(await readFile(f.shared.passwordFile, "utf8")).iv,
        );
        await f.shared.clearPassword();
        await f.shared.clearPassword();
        assert.equal(await f.shared.loadPassword(), null);
    } finally {
        await f.cleanup();
    }
});

for (const [name, options, dcId] of [
    ["without 2FA", {}, 1],
    ["with 2FA", { password: true }, 1],
    ["with DC migration", { migrate: true }, 4],
    [
        "with DC migration before 2FA",
        { migrate: true, password: true, migrateBeforePassword: true },
        4,
    ],
    [
        "with DC migration after 2FA",
        { password: true, migrateAfterPassword: true },
        4,
    ],
])
    test(`issue ${name}`, async () => {
        const f = await fixture(options);
        try {
            if (options.password)
                await f.shared.savePassword("password-secret");
            assert.deepEqual(await f.shared.issue(), {
                session: "new-session",
                dcId,
            });
            assert.equal(await f.shared.load(), "updated-root");
            assert.equal(f.calls.filter(([n]) => n === "destroy").length, 1);
            if (options.password) {
                const get = f.calls.find(([n]) => n === "GetPassword");
                const check = f.calls.find(([n]) => n === "CheckPassword");
                assert.equal(get[1], check[1]);
                assert.equal(check[2].password, "check");
            }
        } finally {
            await f.cleanup();
        }
    });

test("wrong password is marked invalid and never checked twice", async () => {
    const f = await fixture({ password: true, wrong: true });
    try {
        await f.shared.savePassword("password-secret");
        for (let i = 0; i < 2; i++)
            await assert.rejects(f.shared.issue(), {
                code: "telegram_password_invalid",
                message: "telegram_password_invalid",
            });
        assert.deepEqual(await f.shared.loadPassword(), {
            password: "password-secret",
            invalid: true,
        });
        assert.equal(f.calls.filter(([n]) => n === "CheckPassword").length, 1);
        assert.equal(f.calls.filter(([n]) => n === "GetPassword").length, 1);
    } finally {
        await f.cleanup();
    }
});

test("flood waits during export and password check preserve seconds", async () => {
    for (const options of [
        { flood: "FLOOD", floodSeconds: 30 },
        { password: true, passwordFlood: true },
    ]) {
        const f = await fixture(options);
        try {
            if (options.password) await f.shared.savePassword("password-secret");
            await assert.rejects(f.shared.issue(), {
                code: "telegram_busy",
                seconds: 30,
            });
            if (options.password)
                assert.deepEqual(await f.shared.loadPassword(), {
                    password: "password-secret",
                    invalid: false,
                });
        } finally {
            await f.cleanup();
        }
    }
});

for (const [options, code] of [
    [{ unlinked: true }, "telegram_not_linked"],
    [{ password: true }, "telegram_password_missing"],
    [{ flood: "FLOOD_WAIT_17" }, "telegram_busy"],
    [{ flood: "FLOOD_WAIT" }, "telegram_busy"],
    [{ saveError: true }, "telegram_issue_failed"],
])
    test(`safe error ${code} ${JSON.stringify(options)}`, async () => {
        const f = await fixture(options);
        try {
            await assert.rejects(f.shared.issue(), (error) => {
                assert.equal(error.code, code);
                assert.equal(error.message, code);
                assert.doesNotMatch(
                    error.message,
                    /password-secret|session-secret|token-secret/,
                );
                if (code === "telegram_busy") assert.equal(error.seconds, 17);
                return true;
            });
            if (options.saveError)
                assert.equal(f.calls.filter(([n]) => n === "LogOut").length, 1);
            if (!options.unlinked)
                assert.equal(
                    f.calls.filter(([n]) => n === "destroy").length,
                    1,
                );
        } finally {
            await f.cleanup();
        }
    });

test("issue and approve share one queue", async () => {
    const f = await fixture();
    try {
        const original = f.shared.accept.bind(f.shared);
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let entered;
        const started = new Promise((resolve) => {
            entered = resolve;
        });
        let count = 0;
        f.shared.accept = async (token) => {
            if (++count === 1) {
                entered();
                await gate;
            }
            return original(token);
        };
        const first = f.shared.issue();
        await started;
        const second = f.shared.issue();
        const approval = f.shared.approve(Buffer.from("token"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.calls.filter(([n]) => n === "connect").length, 1);
        release();
        await Promise.all([first, second, approval]);
        assert.equal(count, 3);
    } finally {
        await f.cleanup();
    }
});

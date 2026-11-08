import { test } from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";

import { CloudGramApi } from "../app.js";
import { Shares } from "../shares.js";

for (const enabled of [true, false]) {
    test(`login rejects a superseded verifier: flag=${enabled}`, async () => {
        const loginKey = "a".repeat(64);
        const salt = Buffer.alloc(16, 1);
        const verifier = {
            salt: salt.toString("base64"),
            hash: scryptSync(loginKey, salt, 32).toString("base64"),
        };
        const user = { username: "alice", verifier };
        const db = {
            data: { users: { alice: user }, sessions: {}, shares: {} },
            async save() {},
        };
        const api = new CloudGramApi({
            db,
            pepper: "x".repeat(40),
            credentialGuard: enabled,
        });
        let issued = false;
        const pending = api.login(
            {
                ip: "127.0.0.1",
                headers: {},
                body: { username: "alice", loginKey },
            },
            {
                cookie() {
                    issued = true;
                },
            },
        );
        // Model rotation's final synchronous replacement while scrypt is pending.
        user.verifier = { ...verifier };
        if (enabled) {
            await assert.rejects(pending, { code: "bad_credentials" });
            assert.equal(issued, false);
            assert.equal(Object.keys(db.data.sessions).length, 0);
        } else {
            await pending;
            assert.equal(issued, true);
        }
    });

    test(`concurrent share reservations respect quota: flag=${enabled}`, async () => {
        const db = {
            dir: "security-test-missing-directory",
            data: { shares: {} },
            async save() {},
        };
        const shares = new Shares({
            db,
            now: () => 1,
            quota: 20,
            quotaGuard: enabled,
            authenticate: async () => ({ user: { username: "alice" } }),
        });
        const req = {
            body: { bytes: 16, days: null, meta: { iv: "AA==", ct: "AA==" } },
        };
        const outcomes = await Promise.allSettled([
            shares.create(req, {}),
            shares.create(req, {}),
        ]);
        assert.equal(
            outcomes.filter((r) => r.status === "fulfilled").length,
            enabled ? 1 : 2,
        );
        if (enabled) {
            assert.equal(
                outcomes.find((r) => r.status === "rejected").reason.code,
                "share_quota",
            );
        }
        assert.equal(
            Object.values(db.data.shares).reduce((n, s) => n + s.bytes, 0),
            enabled ? 16 : 32,
        );
    });
}

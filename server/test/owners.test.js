import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Owners } from "../owners.js";

test("ledger persists, reloads and enforces one owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owners-"));
    try {
        const owners = await new Owners(dir).open();
        await Promise.all([owners.add("alice", 1), owners.add("alice", 2)]);
        await assert.rejects(owners.add("bob", 1));
        const path = join(
            dir,
            "owners",
            `${createHash("sha256").update("alice").digest("hex")}.json`,
        );
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
            v: 1,
            ids: [1, 2],
        });
        const reload = await new Owners(dir).open();
        assert.equal(reload.count("alice"), 2);
        assert.deepEqual(reload.filterOwned("alice", [2, 3, 1]), [2, 1]);
        await reload.remove("bob", [1]);
        assert.equal(reload.owns("alice", 1), true);
        await reload.remove("alice", [1]);
        await reload.add("bob", 1);
        assert.equal((await new Owners(dir).open()).owns("bob", 1), true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

/**
 * Resolving Dropbox shared links: only Dropbox links go out, and only a
 * redirect onto Dropbox's download host comes back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Dropbox, normalizeLink } from "../dropbox.js";

const LINK = "https://www.dropbox.com/scl/fo/abc123/HASH?rlkey=key&dl=0";

function make(replies) {
    const calls = [];
    const dropbox = new Dropbox({
        now: () => 0,
        authenticate: async () => ({ user: { username: "u" } }),
        fetch: async (url, options) => {
            calls.push({ url: String(url), options });
            const next = replies.shift();
            if (next instanceof Error) throw next;
            return {
                status: next.status,
                headers: new Headers(
                    next.location ? { location: next.location } : {},
                ),
                body: null,
            };
        },
    });
    const resolve = (url) => dropbox.resolve({ body: { url } }, {});
    return { resolve, calls };
}

test("normalizeLink takes Dropbox shared links only", () => {
    assert.equal(
        normalizeLink(LINK).href,
        "https://www.dropbox.com/scl/fo/abc123/HASH?rlkey=key&dl=1",
    );
    assert.equal(
        normalizeLink("https://dropbox.com/s/xyz/a.jpg").href,
        "https://www.dropbox.com/s/xyz/a.jpg?dl=1",
    );
    for (const bad of [
        "http://www.dropbox.com/scl/fo/a/b",
        "https://www.dropbox.com.evil.test/scl/fo/a/b",
        "https://evil.test/scl/fo/a/b",
        "https://www.dropbox.com/home",
        "https://www.dropbox.com/scl/fx/a",
        "not a url",
        "",
    ]) {
        assert.equal(normalizeLink(bad), null, bad);
    }
});

test("returns the download URL Dropbox redirects to", async () => {
    const target = "https://uc1.dl.dropboxusercontent.com/zip_download_get/T";
    const { resolve, calls } = make([{ status: 302, location: target }]);
    assert.deepEqual(await resolve(LINK), { url: target });
    assert.equal(calls[0].options.redirect, "manual");
    assert.match(calls[0].url, /dl=1/);
});

test("follows Dropbox's own rewrites, nothing else", async () => {
    const target = "https://uc2.dl.dropboxusercontent.com/cd/0/get/X";
    const ok = make([
        { status: 301, location: "/scl/fi/new/a.jpg?rlkey=k&dl=1" },
        { status: 302, location: target },
    ]);
    assert.deepEqual(await ok.resolve(LINK), { url: target });

    const away = make([{ status: 302, location: "https://evil.test/x" }]);
    await assert.rejects(away.resolve(LINK), { code: "dropbox_unavailable" });
    const http = make([
        { status: 302, location: "http://uc.dl.dropboxusercontent.com/x" },
    ]);
    await assert.rejects(http.resolve(LINK), { code: "dropbox_unavailable" });
});

test("maps Dropbox failures to readable errors", async () => {
    await assert.rejects(make([]).resolve("https://evil.test/scl/fo/a/b"), {
        code: "dropbox_bad_link",
    });
    await assert.rejects(make([{ status: 404 }]).resolve(LINK), {
        code: "dropbox_not_found",
    });
    // a password page or a folder too big to zip comes back as HTML
    await assert.rejects(make([{ status: 200 }]).resolve(LINK), {
        code: "dropbox_unavailable",
    });
    await assert.rejects(make([{ status: 429 }]).resolve(LINK), {
        code: "dropbox_busy",
    });
    await assert.rejects(make([new Error("ECONNRESET")]).resolve(LINK), {
        code: "dropbox_unreachable",
    });
});

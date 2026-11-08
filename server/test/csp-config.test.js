import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("nginx permits Cloudflare integrations without arbitrary inline scripts", async () => {
    const config = await readFile(
        new URL("../../deploy/nginx/cloudgram.conf", import.meta.url),
        "utf8",
    );
    const policies = [
        ...config.matchAll(
            /add_header Content-Security-Policy "([^"]+)" always;/g,
        ),
    ].map((match) => match[1]);
    assert.equal(policies.length, 2);
    assert.equal(policies[0], policies[1]);
    const directives = new Map(
        policies[0].split(";").map((part) => {
            const [name, ...values] = part.trim().split(/\s+/);
            return [name, values];
        }),
    );
    const script = directives.get("script-src");
    assert.ok(script.includes("'nonce-$request_id'"));
    assert.ok(script.includes("https://static.cloudflareinsights.com"));
    assert.ok(!script.includes("'unsafe-inline'"));
    assert.ok(!script.includes("https:"));
    assert.ok(
        directives
            .get("connect-src")
            .includes("https://cloudflareinsights.com"),
    );
    assert.ok(
        directives
            .get("font-src")
            .includes("https://fonts.gstatic.com/s/roboto/"),
    );
    assert.match(config, /add_header Cache-Control "no-store" always;/);
    assert.match(config, /etag off;/);
    assert.match(config, /if_modified_since off;/);
});

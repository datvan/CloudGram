# Cloudflare and browser content policy

`deploy/nginx/cloudgram.conf` owns the production CSP. Both header copies must
stay identical: nginx discards inherited headers when a location adds its own.
The app bundles Roboto locally; the external Roboto font path below supports
the browser request reported during deployment without granting external scripts
access through a font exception.

| Source                                  | Purpose                                                                  | CSP directive |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------- |
| Per-response `$request_id` nonce        | Cloudflare JavaScript Detections adds this nonce to its injected scripts | `script-src`  |
| `https://static.cloudflareinsights.com` | Cloudflare Web Analytics script                                          | `script-src`  |
| `https://cloudflareinsights.com`        | Analytics reports (same-origin reports are already allowed)              | `connect-src` |
| `https://fonts.gstatic.com/s/roboto/`   | Roboto font versions requested by the browser                            | `font-src`    |
| `http://127.0.0.1:47633`                | Local helper that cuts videos over Telegram's limit (`public/helper`)    | `connect-src` |
| `https://up.datvan.com:8444`            | Direct upload of video chunks for an outside player, past Cloudflare     | `connect-src` |

Scripts still require an allowed origin or matching nonce. Arbitrary inline
scripts remain blocked; do not replace the nonce with `unsafe-inline`, a fixed
value, or a hash copied from a console error. Cloudflare's injected script changes
per request, so a fixed hash will fail again. `$request_id` requires the
OpenSSL-enabled nginx build used by this VPS. HTML responses use `no-store`
with ETag/If-Modified-Since handling disabled so cached bodies cannot retain an
older nonce. Hashed `/assets/` files keep their immutable caching.

## Deployment and verification

The ordinary app deployment does not install nginx configuration. Back up the
active CloudGram site config, install this file, run `nginx -t`, then reload
nginx. Restore the backup if validation fails. Keep the API environment and all
five [security feature flags](security-flags.md) unchanged.

Verify two fresh public HTML responses have distinct nonce values and each
Cloudflare-injected inline script has the matching nonce. Request with old
conditional headers and verify a fresh 200 response. Check the browser console
for script/font CSP violations and verify the sign-in page loads. An anonymous
401 from `/api/me` is expected. Real Telegram upload/playback remains a separate
authenticated check.

Rollback: restore the backed-up site config, run `nginx -t`, then reload nginx.
This restores the previous CSP, including its blocked Cloudflare scripts.

Cloudflare documents nonce propagation in
[JavaScript Detections and CSP](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-you-have-a-content-security-policy-csp).

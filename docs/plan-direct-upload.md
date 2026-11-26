# Plan: direct tgx upload over up.example.com (2026-11-26)

Non-admin uploads go browser → Cloudflare → nginx → node → Telegram
(`/api/tgx/*`). They are slow and large files drop midway. This plan says
what was measured, what to fix first, and how to build the direct path in
small slices.

## Measurements (2026-11-26, from the user's PC)

| Path | Result |
|---|---|
| Real uploads, server log (4 uploads, 56-180 MiB) | 1.1-1.3 MiB/s end to end |
| Server time per 4 MiB part PUT (savePart to Telegram) | p50 0.8-1.0 s, p90 1.3-1.6 s |
| `PUT` 2.9 MB through Cloudflare, 1 stream | ~0.4 MB/s |
| `PUT` 2.9 MB through Cloudflare, 4 parallel | ~1.3 MB/s total |
| Raw upload straight to the VPS (ssh, 30 MB) | 19-23 MB/s |

**Conclusion.** The bottleneck is the Cloudflare hop: ~0.35 MB/s per
request, which matches the 1.3 MiB/s seen in real uploads. The Telegram side
has room for more: 4 batches of 4 MiB in ~1 s each is ~16 MiB/s. A direct
path to the origin should give roughly 5-10x, capped by savePart.

## Why large uploads drop

Server log, 10:33:33 → 10:34:08: the lease heartbeat (every 10 s, TTL 30 s)
went quiet for 35 s. The next part PUT got `409 lease_required` and the
upload was cancelled.
- Likely cause, unproven: the browser throttles timers in a hidden tab, or
  the heartbeat queues behind the part PUTs on the slow Cloudflare hop.
- Long uploads make this more likely. A 2 GB file takes ~25 min at today's
  speed.

## Phase 0: stop the drops (before or alongside speed work)

1. Prove the cause. Log each heartbeat gap with `document.visibilityState`
   into the client diag log. Then reproduce: hide the tab during a 200 MB
   upload.
2. Fix:
   - Server: an authorized tgx request from the lease-holding browser also
     renews the lease.
   - Client: on `409 lease_required`, take the lease again and retry the
     batch once, instead of failing the upload.
   - Keep the lease rule itself. It protects the one-Telegram-client
     invariant.

## Phase 1: direct part PUTs over `up.example.com:8444`

Reuse the `/api/play` direct pattern: per-session key, no cookie, CORS only
for `https://cloudgram.example.com`, fallback to same-origin. CSP already
allows this origin. Read `docs/security-flags.md` first.

**Slice A (server).**
- `tgx/upload/start` returns an extra random upload key, only when
  `CLOUDGRAM_TGX_DIRECT=1`.
- The key is bound to account, upload id and browser/lease.
- It is revoked on finish, cancel, logout, lease loss, and after 6 h.
- A new route accepts part PUTs with `X-Upload-Key` and no cookie. It runs
  the same validation, rate limits and attempt caps as the cookie route.
  Constant-time key compare.
- Start, finish and cancel stay cookie-only through Cloudflare.

**Slice B (nginx).**
- One location on 8444 for the part-PUT path regex.
- CORS: PUT/OPTIONS, `X-Upload-Key` header.
- `client_max_body_size` 5m, `client_body_timeout` 120 s,
  `proxy_read_timeout` ≥ 90 s.
- Its own `limit_req` zone.

**Slice C (client).**
- `VITE_TGX_DIRECT_URL` turns it on. `proxyClient.js` sends parts there when
  start returned a key.
- If the direct origin is unreachable (network error), it falls back to the
  Cloudflare path for the rest of the upload.

**Slice D: review and ship.**
- `security-audit` on the diff. Risks to check:
  - a leaked key used for upload abuse;
  - DoS against the exposed origin IP;
  - any quota, lease or ledger check skipped.
- Back up the VPS, deploy, then test live with `test-preview`. Turning it on
  is a flag flip; rolling back is a flag flip.

## Phase 2 (only if still short of expectations)

Raise savePart parallelism per batch (groups of 4 today) and/or batches in
flight. Measure from the server log after Phase 1 before touching it.

## Not doing now

- Upload resume after a page reload.
- Moving start/finish off Cloudflare.
- Changing Cloudflare plan or rules.

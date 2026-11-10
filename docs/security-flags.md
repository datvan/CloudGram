# Security fixes and rollback

All five fixes default to enabled. Only the exact value `0` disables a fix;
unset, `1`, and other values keep it enabled. No database migration or dependency
change is needed. Disable only the affected fix: rollback restores its previous
security exposure.

| Flag                                  | Configuration              | Protection                                                                                                                                                                        |
| ------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SECURITY_STREAM_GUARD`          | Frontend build environment | Stream requests require a requesting tab and audio/video destination; responses carry restrictive CSP and nosniff, with passive MIME fallback                                     |
| `VITE_SECURITY_UPLOAD_OWNER`          | Frontend build environment | Queued, retrying and in-flight uploads remain bound to their original account session; stale dialogs, resume and Dropbox producers stop before enqueuing into a different account |
| `VITE_SECURITY_LOG_OWNER`             | Frontend build environment | Pending upload-log batches capture owner and key before logout; reads discard results after an account switch                                                                     |
| `CLOUDGRAM_SECURITY_CREDENTIAL_GUARD` | API environment            | Login cannot issue a session using a verifier superseded during password verification                                                                                             |
| `CLOUDGRAM_SECURITY_SHARE_QUOTA`      | API environment            | Share count and quota checks run immediately before reservation without an intervening await                                                                                      |

## Frontend rollback

Set the affected `VITE_SECURITY_*` value to `0` in the build environment and
rebuild with `npm run build`. Publish the resulting frontend using the normal
deployment process. Changing the VPS API environment alone does not change
frontend flags. To restore protection, remove the override or set it to `1`,
then rebuild and publish again.

Close existing app tabs and reopen after either change. Streaming uses the flag
in the service-worker script registration URL. An already loaded tab or active
worker can retain the previous policy until worker activation and page reload;
verify the active worker URL in browser developer tools. Flag values in a page
URL or localStorage do not configure these fixes.

## API rollback

Set the affected `CLOUDGRAM_SECURITY_*` value to `0` in
`/etc/cloudgram-api.env`, then restart `cloudgram-api`. Remove the override or
set it to `1` and restart to restore protection. Keep all other environment
values unchanged. Each API process must use the same settings.

## Upload behavior

Logout invalidates the tab's upload session before asynchronous logout work.
The browser stops stale jobs instead of sending them through another account.
Existing upload-log records stay under their original account for its resume
flow. A request already dispatched to Telegram cannot be recalled by a flag or
logout; it remains associated with the original client. Reconnect or lease
reacquisition without logout preserves the account session and normal retries.

If saving the uploaded message ID fails, the original is kept and the transfer
panel offers **Lưu lại và thử xoá bản gốc**. This action retries tree persistence
before deletion, verifies the same message ID is still on a live record outside
the trash, and retains the original if saving fails again. Account scope and
local file identity/permission checks still apply. Retry does not upload a
second Telegram copy. The handle is held in this tab; keep the tab open to retry.

## Validation status

Regression cases live in `server/test/security.test.js` and
`server/test/browser-security.test.js`. They cover enabled and disabled policy,
quota concurrency, a superseded credential snapshot, blocked stream navigation,
account switching before queued upload, dialogs, Dropbox resolution or media preparation completes, and
deferred log ownership. Browser tests use isolated substitutes for Telegram,
IndexedDB and service-worker events; they do not prove real browser playback.

Development validation: 40/40 tests passed with dummy fixtures, along with lint,
production build, static JavaScript syntax and `git diff --check`. Independent
Standards and Spec reviews found no required changes. The earlier security
audit was source-only; these development checks do not retroactively confirm
its production exploit hypotheses. Whole-repository Prettier reports existing
formatting debt; formatting is checked separately for changed files.

Live playback with Telegram (including seeking and storyboards), account
switch/resume and service-worker rollback still need browser validation.

## Agent maintenance checklist

1. Keep all five flags default-on and operator-controlled. Frontend flags are
   compiled by Vite; API flags are read at process startup. Use the names in the
   table above and the exact `0` opt-out convention.
2. Preserve both enabled and disabled paths. Update regression tests when a
   guarded behavior changes; disabled behavior intentionally restores the old
   exposure, so document the risk before using rollback.
3. Bind async upload producers, queue jobs and completion work to the original
   `uploadScope()` object. Logout invalidates it; same-account connection/lease
   changes preserve it. Keep pending log batches under their captured owner/key.
4. Keep quota recount and reservation in the same synchronous turn, and check
   the current user/verifier after asynchronous credential verification.
5. Run the package's API tests, lint and production build; check formatting on
   changed files. Report fixture checks separately from real Telegram/browser
   checks. Verify the active service-worker registration after flag changes.
6. Update this canonical document, environment examples and both agent pointers
   together when the flag contract changes. Publish and deploy only with user
   authorization; verify deployed assets and API health after deployment.

## Playing in an outside player (VPS relay)

These are features, not security fixes, but they move video through the VPS, so
they are listed here. Only the exact value `0` disables them.

| Flag                           | Configuration              | Effect                                                                                        |
| ------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| `VITE_FEATURE_EXTERNAL_PLAYER` | Frontend build environment | The "Mở bằng PotPlayer, VLC..." button; `0` removes it                                        |
| `CLOUDGRAM_PLAY`               | API environment            | `0` makes `POST /api/play` answer 403 `play_off`; existing addresses stop at the next restart |
| `CLOUDGRAM_PLAY_CACHE_MB`      | API environment            | Cache cap for all videos together (default 1024 MB); each video also keeps at most 512 MB     |

How it works (`server/play.js`): the signed-in tab opens a session and answers
the server's long-poll for 2 MiB chunks, reading them from Telegram; the player
reads `/api/p/<token>/<name>` with Range and no cookie. The token is random and
is the only credential. **The video passes through the VPS unencrypted**, and
anyone holding the address can read it until the tab closes, "Dừng" is pressed,
the tab goes silent for 90 s, 12 h pass, or the API restarts (it empties
`/var/lib/cloudgram-api/play` at start). Limits: 3 videos per account, 8 in
all, and none start with less than 1 GiB of free disk.

Verify: `npm run test:api` (`play.test.js`, `external-player.test.js`). Not
verified without a real Telegram account: a real player on the VPS address,
Cloudflare's terms and timeouts for video, `potplayer://https://...` in Chrome.

### Direct upload past Cloudflare

Uploading a 2 MiB chunk to `cloudgram.datvan.com` measured 3-11 KB/s from the
owner's network (Cloudflare to the VPS), against 7 MB/s straight to the VPS, so
the tab can put chunks at `VITE_PLAY_DIRECT_URL` (`https://up.datvan.com:8444`,
frontend build environment; empty = through the page's address, and it falls
back to that by itself when the direct address cannot be reached).

-   DNS: `up` as an A record to the VPS, **DNS only** (grey cloud).
-   `deploy/vps-direct-upload.sh` installs `deploy/nginx/cloudgram-upload.conf`,
    gets a Let's Encrypt certificate (port 80 is opened by certbot's hook only
    while it runs) and opens `8444/tcp` in ufw. Only that nginx listens on 8444;
    it accepts nothing but `PUT /api/play/<id>/chunks/<n>`, so no other site on
    the VPS is reachable without Cloudflare.
-   No cookie crosses origins: the session has its own random key, sent as
    `X-Play-Key` and checked in constant time (`server/play.js`). The origin IP
    is now in public DNS for `up.datvan.com` (it was already in git history).
-   Rollback: remove the `cloudgram-upload.conf` site link, `ufw delete allow
8444/tcp`, reload nginx, restore `cloudgram.conf` from the script's backup.

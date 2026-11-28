# Deploying CloudGram to cloudgram.example.com

**English** · [Tiếng Việt](deploy.md)

Example: https://cloudgram.example.com, served by nginx on a private VPS behind
the Cloudflare proxy.

> This repository is public, so the server IP is not written here. It lives in
> `.env` (gitignored) as `DEPLOY_HOST`.

Repo: https://github.com/datvan/CloudGram

---

## Before you read on: the api_hash will be public

Vite inlines every `VITE_*` variable straight into the JS sent to the browser.
The app speaks MTProto to Telegram directly from the browser; the account
service on the VPS (see
[Accounts and the encrypted vault](#accounts-and-the-encrypted-vault)) can also
approve new sessions using the encrypted shared root session.

The consequence: **anyone who opens cloudgram.example.com can read your `api_id`
and `api_hash`** by viewing the source. They cannot get into your Telegram
account (that sits behind the CloudGram account and is encrypted with its
password), but they can use that api_id/api_hash pair for their own app, and if
they abuse it, **Telegram bans the api_id — yours.**

So: create a **separate** Telegram app for this deployment, and do not reuse an
api_id/api_hash pair you use for anything else.

Moving the site elsewhere does not change this. The key identifies the
application to Telegram; it has nothing to do with who serves the HTML file.

---

## Step 1 — Get an api_id and api_hash and put them in `.env`

1. Open https://my.telegram.org and sign in with your **Telegram phone
   number**. The confirmation code arrives in the Telegram app itself, not by
   SMS.
2. Choose **API development tools**.
3. Fill in the form: App title `CloudGram`, Short name `cloudgram`, Platform
   **Web**, URL `https://cloudgram.example.com`.
4. Click **Create application**. The result page shows `App api_id` (a number)
   and `App api_hash` (32 hex characters). Save them in a password manager
   right away.
5. Put them in `.env` at the repository root:

```
VITE_API_ID=1234567
VITE_API_HASH='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

`.env` is in `.gitignore`, so it is never committed.

> my.telegram.org rate-limits very strictly and often answers
> `Too many attempts. Please try again later.` When that happens, **stop
> clicking**, wait a few hours and try again; retrying in quick succession
> restarts the timer. Switching networks (a phone hotspot instead of wifi)
> sometimes helps, since the limit is per IP.

---

## Step 2 — Deploy

Add the target machine to `.env`, next to the Telegram keys:

```
DEPLOY_HOST=root@<vps-ip>
SITE_HOST=cloudgram.example.com
UPLOAD_HOST=up.example.com
VITE_SITE_HOST=cloudgram.example.com
```

`DEPLOY_HOST` has no `VITE_` prefix, so Vite does not inline it into the bundle sent to
the browser.

**The first time**, install the account service and the new nginx config:

```bash
bash deploy/vps-setup.sh
```

This script changes system configuration on the VPS, so read it before running
it. It creates a `cloudgram` system user, copies `server/` to
`/opt/cloudgram-api`, generates `/etc/cloudgram-api.env` (holding a random
`CLOUDGRAM_PEPPER`, readable by root only), installs the
[cloudgram-api.service](../deploy/systemd/cloudgram-api.service) unit and the
`cloudgram-admin` command, then replaces the nginx config — running `nginx -t`
first and restoring the old one on failure. It is safe to re-run; an existing
pepper is kept.

**After that**, all it takes is:

```bash
npm run deploy
```

This builds, then runs [deploy/vps-deploy.sh](../deploy/vps-deploy.sh): it
updates the service code in `/opt/cloudgram-api` and restarts it, then uploads
`dist` to `/var/www/cloudgram.incoming` and `mv`s it over `/var/www/cloudgram`.
Upload first, swap second — `scp` takes a few seconds for ~50 files while nginx
keeps serving users; swapping with `mv` shrinks the broken window to a few
milliseconds. It refuses to run if the VPS does not have the service yet, since
the new build does not work without `/api`.

The script ends by checking `/`, `/folder/x` and `/api/me` (a 401 when not
signed in is correct).

After changing `.env`, re-running the command above is enough — the variables
are read at build time.

---

## Accounts and the encrypted vault

You sign in to CloudGram with its own account; the Telegram account sits behind
it. Only the admin creates accounts:

```bash
ssh root@<vps-ip> cloudgram-admin add <name>      # prints a setup link, valid 7 days, single use
ssh root@<vps-ip> cloudgram-admin reset <name>    # forgotten password: new link, old vault wiped
ssh root@<vps-ip> cloudgram-admin delete <name>
ssh root@<vps-ip> cloudgram-admin list
ssh -t root@<vps-ip> cloudgram-admin telegram-password       # store 2FA password via hidden prompt
ssh root@<vps-ip> cloudgram-admin telegram-password-clear   # remove stored 2FA password
ssh root@<vps-ip> cloudgram-admin telegram-status           # show link and password status
```

`cloudgram-admin` stops the service while it runs and starts it again, because
the service keeps `db.json` in memory and would overwrite the change.

The user opens the link and sets a password (at least 10 characters). A separate
Telegram session is created automatically when the shared root is configured;
otherwise the user links Telegram manually.

**The user vault is encrypted.** With shared Telegram, the VPS can decrypt the
root session and access Telegram. The password goes through PBKDF2-SHA256
(600,000 iterations) in the browser and is split in two halves: one is sent as
the login key (the server stores only its scrypt hash), the other unlocks a
random AES-256-GCM data key. The Telegram session and the folder tree are
encrypted with that data key before upload. The consequence: **a forgotten
password means a lost vault** — `reset` lets the user sign in again, but
Telegram must be linked again and the folder tree starts empty (the files are
still in Saved Messages).

**Data on the VPS** lives in `/var/lib/cloudgram-api` (`db.json` for accounts
and sessions, `trees/<id>.json` for encrypted folder trees). Back up that
directory and the root key separately. The pepper in
`/etc/cloudgram-api.env` is only used to derive fake salts for names that do
not exist (so nobody can probe which names have accounts); losing or changing
it does not break sign-in, but it should stay fixed.

**Share links** are the exception: the file is copied, encrypted, to the VPS
under `/var/lib/cloudgram-api/shares/<id>/`, because the recipient has no
Telegram. The decryption key lives only after the `#` in the link, so the
server cannot read the file. When a link expires or is removed, its copy is
deleted within a minute. Each file is capped at 2 GB, each account at 500 links
and 20 GB (change it with `CLOUDGRAM_SHARE_QUOTA_GB` in
`/etc/cloudgram-api.env`); the server always keeps 1 GB of disk free. Whole
folders cannot be shared yet.

**Dropbox import** is the opposite and stores nothing on the VPS: the server
only asks Dropbox where a shared link redirects (`POST /api/dropbox/resolve`,
which accepts `dropbox.com` links only), and the browser downloads the ZIP
straight from Dropbox and sends each file to Telegram. Dropbox will not zip a
folder over 20 GB or 10,000 files; split such a folder into smaller links.

**One machine uses Telegram at a time.** If two browsers use the same Telegram
session, Telegram kills it (`AUTH_KEY_DUPLICATED`), so the service hands out a
"lease" to one browser at a time. Opening the app on a second machine asks
whether to move over to it; the old machine lets go within a few seconds.

**Signing out** only removes the CloudGram session on that machine; the
Telegram session stays for other machines. To cut Telegram off entirely, use
"Huỷ liên kết Telegram" (Unlink Telegram) in the account menu.

---

## How the infrastructure fits together

This section records things that took effort to find out, so they need not be
rediscovered.

Configure DNS, TLS and firewall rules for your own deployment. Restrict origin access to your trusted proxy where applicable.

## Rebuilding from scratch

If this has to be redone on another machine:

Use [cloudgram.bootstrap.conf](../deploy/nginx/cloudgram.bootstrap.conf), not
`cloudgram.conf`. The bootstrap version listens only on port 80 and mentions no
certificate — exactly what is needed **before** certbot runs. `cloudgram.conf`
is a snapshot taken after certbot edited it; using it to rebuild from scratch
stops nginx from starting, because it points at certificate files that do not
exist yet.

```bash
# on the VPS
mkdir -p /var/www/cloudgram
# replace __SITE_HOST__ with your site host, then copy deploy/nginx/cloudgram.bootstrap.conf to
#   /etc/nginx/sites-available/cloudgram.conf
ln -s /etc/nginx/sites-available/cloudgram.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Then create a `cloudgram` A record pointing at the VPS IP, **with Proxied on**,
and:

```bash
certbot --nginx -d cloudgram.example.com -n --redirect
```

Ensure DNS and your firewall permit certificate validation before running certbot.

The bootstrap config has no `/api`. Once certbot is done, run
`bash deploy/vps-setup.sh` to install the account service and switch to
`cloudgram.conf`. Before that, check that the SSL part of `cloudgram.conf`
matches what certbot just wrote.

---

## Checks after deploying

-   [ ] `https://cloudgram.example.com` → the CloudGram sign-in screen.
-   [ ] Sign in and link Telegram with a phone number (first time only).
-   [ ] The console (F12) shows no MTProto connection errors or CSP
        violations.
-   [ ] Sign in from another browser → the same folder tree, without linking
        Telegram again.
-   [ ] Create a folder, open it, press **F5** → still that folder, no 404.
        This is the test for `try_files`.
-   [ ] Upload several files at once, then run through the checklist in
        [upgrade-plan.md](upgrade-plan.md) (Vietnamese).

Three HTTP behaviours verified on the live site: `/` and `/folder/x` return
200, `/assets/<missing>.js` returns 404, and `http://` redirects 301 to
`https://`.

---

## Appendix — the Cloudflare Pages copy

Before the move to the VPS, the app was deployed with Cloudflare Pages (direct
upload). The `cloudgram` project still exists, served at
`cloudgram-cew.pages.dev`, with no custom domain.

That project still serves the **old build** (from before accounts), with the
same `api_id`/`api_hash`. The `deploy:pages` command has been removed: Pages
has no `/api`, so a new build pushed there would not work. The project should
be deleted so no stale copy floats around:

```bash
npx wrangler pages project delete cloudgram
```

A difference worth remembering between the two: on Pages, the
`public/_redirects` rule (`/* /index.html 200`) catches **every** path, so a
missing asset also returns 200 with HTML. The nginx setup handles `/assets/`
separately, so it does not have that problem.

Security fixes have five default-on feature flags. See
[configuration and rollback](security-flags.md) before disabling a fix.

For CSP or Cloudflare changes, see [nonce policy and nginx deployment](csp.md).

## Shared Telegram

Every CloudGram account receives full access to the same Telegram account and its
messages. Grant access only to trusted users. Set `CLOUDGRAM_TG_API_ID` and
`CLOUDGRAM_TG_API_HASH` in `/etc/cloudgram-api.env` to the frontend app values,
and `CLOUDGRAM_TG_ROOT_KEY` to the output of `openssl rand -base64 32`. Back up
the key safely and do not change it after linking. Restart the API and run
`cloudgram-admin telegram-link`; enter phone, code and 2FA password. Use
`cloudgram-admin telegram-status` to check the root and `telegram-unlink` to
remove it locally. Unlinking does not revoke issued sessions; revoke them in
Telegram. The API host can decrypt the root. Disable with
`CLOUDGRAM_SHARED_TELEGRAM=0` and restart or `VITE_FEATURE_SHARED_TELEGRAM=0`
and rebuild the frontend.

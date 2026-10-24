# Deploying CloudGram to cloudgram.datvan.com

**English** · [Tiếng Việt](deploy.md)

Live at https://cloudgram.datvan.com, served by nginx on a private VPS behind
the Cloudflare proxy.

> This repository is public, so the server IP is not written here. It lives in
> `.env` (gitignored) as `DEPLOY_HOST`.

Repo: https://github.com/datvan/CloudGram

---

## Before you read on: the api_hash will be public

Vite inlines every `VITE_*` variable straight into the JS sent to the browser.
The app speaks MTProto to Telegram directly from the browser; the account
service on the VPS (see
[Accounts and the encrypted vault](#accounts-and-the-encrypted-vault)) only
keeps an encrypted copy of the session and forwards nothing to Telegram. That
is CloudGram's architecture, not a misconfiguration.

The consequence: **anyone who opens cloudgram.datvan.com can read your `api_id`
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
   **Web**, URL `https://cloudgram.datvan.com`.
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
```

The prefix is not `VITE_`, so Vite does not inline it into the bundle sent to
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
```

`cloudgram-admin` stops the service while it runs and starts it again, because
the service keeps `db.json` in memory and would overwrite the change.

The user opens the link, sets a password (at least 10 characters), then links
Telegram once. From then on, signing in on any machine works right away.

**The VPS cannot read the data.** The password goes through PBKDF2-SHA256
(600,000 iterations) in the browser and is split in two halves: one is sent as
the login key (the server stores only its scrypt hash), the other unlocks a
random AES-256-GCM data key. The Telegram session and the folder tree are
encrypted with that data key before upload. The consequence: **a forgotten
password means a lost vault** — `reset` lets the user sign in again, but
Telegram must be linked again and the folder tree starts empty (the files are
still in Saved Messages).

**Data on the VPS** lives in `/var/lib/cloudgram-api` (`db.json` for accounts
and sessions, `trees/<id>.json` for encrypted folder trees). Backing up that
directory is enough; it is useless without the users' passwords. The pepper in
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

**All web traffic must go through Cloudflare.** `ufw` on the VPS opens 80/443
only to Cloudflare's 22 IP ranges (15 IPv4 + 7 IPv6) and blocks every other
source. Calling the server IP directly from outside times out, port 443
included.

In practice: **the DNS record must be Proxied (orange cloud).** Set to
`DNS only`, the site does not work — not as a security matter, there is simply
no way in.

This design is good: DDoS is absorbed by Cloudflare, and any WAF or rate-limit
rule set at Cloudflare cannot be bypassed. It also keeps the origin IP private
— but only as long as that IP is not written down elsewhere, so keep it out of
the repo, issues and screenshots.

**The zone's SSL mode is Full (strict).** Known because, while the origin had no
certificate for the hostname, Cloudflare returned `526` instead of serving
anyway.

**Certbot works behind the proxy**, because Cloudflare lets
`/.well-known/acme-challenge/` through to the origin over plain HTTP without
forcing HTTPS. Verified: that path returns 200 and shows up in nginx's access
log, while every other path gets a 301 from Cloudflare at the edge.

**The certificate** expires on 2027-01-22; Certbot has already installed its
renewal task.

**The nginx config** is in
[deploy/nginx/cloudgram.conf](../deploy/nginx/cloudgram.conf), a copy of
`/etc/nginx/sites-available/cloudgram.conf`. Points worth noting:

-   `location /` uses `try_files $uri $uri/ /index.html` — this is what keeps
    `/folder/<id>` from 404ing on F5.
-   `location /assets/` uses `try_files $uri =404` — on purpose. A missing
    asset must say so; letting it fall back to `index.html` hands the browser
    HTML with status 200 while it waits for JavaScript, and that failure is
    very hard to trace.
-   `location /api/` uses `proxy_pass` to the account service at
    `127.0.0.1:4322`, with no `try_files`: a wrong `/api` path must get a JSON 404.
-   The Content-Security-Policy allows scripts only from the site itself and
    connections to `wss://*.web.telegram.org` (where GramJS speaks MTProto).
    Adding a library that calls out means opening it up here, or the browser
    blocks it silently — check the console.

**SSH login is key-only.** Since 2026-10-24 the server no longer accepts
passwords. These three lines live in
`/etc/ssh/sshd_config.d/00-hardening.conf`:

```
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
```

**The `00` at the start of the file name is deliberate.** sshd takes the
**first** value it reads, and that directory already holds
`50-cloud-init.conf` with `PasswordAuthentication yes`. `00` is read before
`50`, so it wins. Appending to the end of `/etc/ssh/sshd_config` has no effect,
because the `Include` line sits at the top of the file and loads the whole
directory before the end is reached.

`prohibit-password` rather than `no`: root is the only account with a real
shell on the machine, and `no` would lock you out.

Operational consequence: **there is no password fallback any more.** To get in
from another machine, run `ssh-copy-id` from a machine that already works
**first**. Losing every key leaves only the VPS provider's VNC console.

Check by asking the server directly which login methods it offers:

```bash
ssh -v -o BatchMode=yes -o PubkeyAuthentication=no <user>@<vps-ip> 2>&1 | grep -i "that can continue"
```

Correct output is `publickey` alone. Seeing `password` means the config has
not taken effect — usually a forgotten `systemctl reload ssh`. (`BatchMode=yes`
is there precisely for that broken case: without it, the command prints the
line you want and then sits waiting for a password.) Do not judge by sshd's
PID: `SIGHUP` makes it `exec` itself again, so the PID and start time stay the
same even though the config changed.

---

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
# copy deploy/nginx/cloudgram.bootstrap.conf to
#   /etc/nginx/sites-available/cloudgram.conf
ln -s /etc/nginx/sites-available/cloudgram.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Then create a `cloudgram` A record pointing at the VPS IP, **with Proxied on**,
and:

```bash
certbot --nginx -d cloudgram.datvan.com -n --redirect
```

Order matters: DNS must point correctly and the proxy must be on before
calling certbot, or Let's Encrypt hits the IP directly and ufw blocks it.

The bootstrap config has no `/api`. Once certbot is done, run
`bash deploy/vps-setup.sh` to install the account service and switch to
`cloudgram.conf`. Before that, check that the SSL part of `cloudgram.conf`
matches what certbot just wrote.

---

## Checks after deploying

-   [ ] `https://cloudgram.datvan.com` → the CloudGram sign-in screen.
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

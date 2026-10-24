# CloudGram

A file drive that stores your files in your own Telegram account, with a Google Drive style interface and encrypted accounts.

This project started as a fork of [MQ-xz/CloudGram](https://github.com/MQ-xz/CloudGram). It keeps the original's foundation: the browser talks to Telegram directly through [GramJS](https://github.com/gram-js/gramjs) and every file lives in your Saved Messages. On top of that, the interface was rebuilt from scratch as a Google Drive look-alike, and accounts, encrypted sync and self-hosting were added. It is maintained on its own and does not track the original repository.

## What changed from the original

**A rebuilt Drive UI**

-   My Drive, Recent, Starred and Trash, with breadcrumbs, search and light/dark themes.
-   Grid and list views; the grid shows thumbnails for pictures and videos.
-   Upload files or whole folders by picker or drag and drop, through a bounded queue with progress and retry.
-   Rename, move (dialog or drag onto a folder), star, trash, restore and delete forever, single or in bulk.
-   Preview pane for images, video, audio, PDF and text, plus a details panel.

**Pictures and videos like the Telegram apps**

-   JPEG/PNG and MP4/MOV are sent as media by default (compressed photo, playable video), with the option to send them as files kept byte for byte. The choice is remembered.

**Accounts and encrypted sync**

-   A small account service (`server/`, Node, no dependencies) puts a CloudGram account in front of the Telegram account. Accounts are created by the admin from a CLI; there is no public sign-up.
-   The Telegram session and the folder tree are encrypted in the browser with a key derived from your password before they reach the server. The server only ever holds ciphertext, so the same account works from any browser.
-   Only one browser holds the Telegram connection at a time, which avoids Telegram's duplicate-session errors.

**Self-hosting**

-   nginx, systemd and deploy scripts for a single VPS live in `deploy/`; [docs/deploy.md](docs/deploy.md) walks through it.

## How it works

The browser speaks MTProto to Telegram itself; file bytes never pass through the server. The account service stores only encrypted blobs and login verifiers. Note that the Telegram `api_id` and `api_hash` are compiled into the public bundle, as in any browser Telegram client, so use an app created only for this deployment.

## Development setup

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/datvan/CloudGram.git
cd CloudGram
npm install
```

2. Copy `.env.example` to `.env` and fill `VITE_API_ID` and `VITE_API_HASH` with your own Telegram application ([Creating your Telegram Application](https://core.telegram.org/api/obtaining_api_id)).

3. Start the web app:

```bash
npm run dev
```

4. In a second terminal, start the account service (copy `server/.env.dev.example` to `server/.env.dev` first) and create an account:

```bash
npm run dev:api
node --env-file=server/.env.dev server/cli.js add <username>
```

Restart `dev:api` after the CLI command; it keeps the database in memory.

5. Open the printed setup link (it points at `http://localhost:5173/setup#...`), choose a password and link Telegram.

## Credits

Built on [MQ-xz/CloudGram](https://github.com/MQ-xz/CloudGram); see [LICENSE](LICENSE).

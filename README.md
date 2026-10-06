# Private Space

A private, self-hosted communication web app for **exactly two people**:
text, photos, videos, documents and links, in real time, installable as a
PWA on Android, iPhone and desktop.

Every notification shows only one word:

> **Reminder**

No sender, no message, no preview, no file name, no link, no image.

---

- **Open source only.** Node.js, TypeScript, Express, `ws`, React, Vite,
  PostgreSQL or SQLite, Argon2, sharp, ffmpeg, `web-push`, Caddy. No
  Firebase, Supabase, cloud-vendor services, analytics or ads.
- **Self-hosted.** One `docker compose up` on any Linux machine (VPS, home
  server, Raspberry Pi…).
- **Private by design.** No public registration, profiles, groups, feeds or
  likes. Files are never served from a public directory. Every request is
  authenticated and authorised on the server.

| | |
|---|---|
| Messaging | Real-time over WebSocket · read/unread ticks · delete your own messages |
| Photos | Camera or gallery · JPEG/PNG/WEBP/GIF · thumbnails · compressed view copy · original kept privately |
| Videos | MP4/MOV/WEBM · upload progress · up to 500 MB (configurable) · thumbnail · in-app playback with seeking |
| Documents | PDF, DOC(X), XLS(X), PPT(X), TXT, ZIP · `📄 name · size · Open · Download` |
| Links | Auto-detected · sanitised · simple card (title, site, URL). No remote images are loaded |
| Shared | Photos · Videos · Documents · Links tabs |
| Notifications | Standard Web Push + VAPID. Always exactly "Reminder" |
| Privacy | Lock screen (“Private Space 🔒”) whenever the app goes to the background |

## Quick start (Docker)

You need a Linux server with Docker and Docker Compose. For notifications
and installation on phones you need HTTPS, so ideally a domain name pointing
at the server (ports 80 and 443 open).

```bash
git clone <your-repo-url> private-communication
cd private-communication
cp .env.example .env
```

Edit `.env`:

```bash
DOMAIN=space.example.com          # your domain, or "localhost" to try it locally
TLS_MODE=you@example.com          # e-mail for free Let's Encrypt certs ("internal" for localhost/LAN)
POSTGRES_PASSWORD=$(openssl rand -base64 32)
```

Generate the Web Push keys and paste the two lines into `.env`:

```bash
docker compose build
docker compose run --rm --no-deps backend node dist/scripts/generate-vapid.js
```

Start everything:

```bash
docker compose up -d
```

### Create the two users

There is no sign-up page. The administrator creates both accounts from the
server's command line (you will be asked for a password, minimum 12
characters; it is not echoed):

```bash
docker compose exec backend node dist/scripts/create-user.js alice
docker compose exec backend node dist/scripts/create-user.js bob
```

After the second user is created, registration is permanently closed — the
command refuses to create a third account, and the server only ever
authorises the first two users.

Forgotten password (also signs that user out everywhere):

```bash
docker compose exec backend node dist/scripts/reset-password.js alice
```

Open `https://<DOMAIN>/` and sign in.

## Install on a phone

- **Android (Chrome/Firefox/Edge):** open the site → menu → *Add to Home
  screen* / *Install app*.
- **iPhone (Safari):** Share → *Add to Home Screen*. Open it from the Home
  Screen, then go to **⋯ → Notifications → Turn on** (iOS only allows web
  notifications for Home Screen apps, iOS 16.4+).
- **Desktop:** install icon in the address bar, or just use the tab.

Notifications are enabled per device in **⋯ (Settings) → Notifications**.

### About the notification text

The server sends no message data in the push at all, and the service worker
ignores whatever payload arrives and always shows the fixed title
`Reminder` with no body, icon or image. The operating system may still add
its own chrome around it — typically the installed app's name (which is
also "Reminder") and a timestamp; on desktop browsers, sometimes the site's
domain. That part is outside any web app's control. See
[docs/SECURITY.md](docs/SECURITY.md#notifications).

## Backups

```bash
./scripts/backup.sh               # → ./backups/<timestamp>/ (database + all files)
./scripts/backup.sh --encrypt     # same, encrypted with GnuPG
./scripts/restore.sh ./backups/<timestamp>
```

Backups stay on your machine. Copy the folder to a disk you control. Details
in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#backups).

## Development

Requirements: Node.js 22+, and `ffmpeg` (optional, for video thumbnails).

```bash
npm install
cp backend/.env.example backend/.env           # SQLite by default
npm run generate-vapid -w backend               # optional: paste into backend/.env
npm run create-user -w backend -- alice
npm run create-user -w backend -- bob
npm run dev:backend                             # http://localhost:3000
npm run dev:frontend                            # http://localhost:5173 (proxies /api and /ws)
```

Tests:

```bash
npm test                                        # backend security suite + frontend unit tests
# Same backend suite against PostgreSQL:
TEST_DB_CLIENT=postgres TEST_DATABASE_URL=postgres://user:pass@localhost/test npm test -w backend
```

## Repository layout

```
├── frontend/            React + TypeScript + Vite PWA
│   ├── public/          manifest.json, service-worker.js, icons
│   └── src/             components/ and lib/ (API, realtime, push)
├── backend/             Node.js + TypeScript + Express + ws
│   ├── src/routes/      auth, messages, files, push
│   ├── src/services/    sessions, users, messages, storage, links, push, realtime
│   ├── src/middleware/  authentication, CSRF/origin checks, errors
│   ├── src/database/    Knex connection + migrations (SQLite ⇄ PostgreSQL)
│   ├── src/scripts/     create-user, reset-password, generate-vapid, backup-sqlite
│   └── test/            security & behaviour tests
├── storage/             private uploads (git-ignored): photos/ videos/ documents/ thumbnails/
├── deploy/Caddyfile     HTTPS reverse proxy + static PWA
├── scripts/             backup.sh, restore.sh, generate-icons.mjs
├── native/              reference code for future Android/iOS widgets
├── docs/                architecture, security, deployment
├── docker-compose.yml
└── .env.example
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data model, real-time flow, E2EE roadmap
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, controls, security test matrix
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — servers, HTTPS options, SQLite mode, updates, backups
- [native/README.md](native/README.md) — home-screen widgets (future native wrappers)

## License

MIT

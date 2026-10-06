# Deployment

Runs on any machine that can run Docker: VPS, home server, university
server, Raspberry Pi (arm64), or any Linux box. No cloud-provider services
are required.

## 1. Requirements

- Docker Engine + Docker Compose plugin
- Ports 80 and 443 reachable (for public HTTPS)
- A DNS name pointing at the server — or use it on a LAN (see below)

## 2. Configure & start

```bash
git clone <your-repo-url> private-communication && cd private-communication
cp .env.example .env && chmod 600 .env
# edit DOMAIN, TLS_MODE, POSTGRES_PASSWORD
docker compose build
docker compose run --rm --no-deps backend node dist/scripts/generate-vapid.js   # paste into .env
docker compose up -d
docker compose exec backend node dist/scripts/create-user.js <first-user>
docker compose exec backend node dist/scripts/create-user.js <second-user>
```

Check: `docker compose ps` (all healthy) and `docker compose logs -f backend`.

## 3. HTTPS options

Service workers, installation and Web Push require HTTPS.

| Situation | `.env` |
| --- | --- |
| Public domain | `DOMAIN=space.example.com`, `TLS_MODE=you@example.com` → free certificate from Let's Encrypt/ZeroSSL, renewed automatically |
| Local test | `DOMAIN=localhost`, `TLS_MODE=internal` |
| LAN only / no domain | `DOMAIN=server.lan` (or the IP), `TLS_MODE=internal`; install Caddy's root certificate on both phones: `docker compose cp frontend:/data/caddy/pki/authorities/local/root.crt .` |
| Behind your own reverse proxy | Expose the backend instead (add `ports: ["127.0.0.1:3000:3000"]`), serve `frontend/dist` yourself, and forward `/api` and `/ws` (with WebSocket upgrade). Set `PUBLIC_ORIGIN`. |

A home server without a public IP can be reached through a self-hosted VPN
such as WireGuard (open source) instead of opening ports.

## 4. SQLite mode (very small deployments)

PostgreSQL is the default. For a single-file database (e.g. a Raspberry Pi
with little RAM), set in `docker-compose.yml` for the backend:

```yaml
      DB_CLIENT: sqlite
      SQLITE_PATH: /data/db/private-space.db
    volumes:
      - storage:/data/storage
      - sqlite:/data/db
```

add `sqlite:` under `volumes:` and remove the `db` service and the
`depends_on: db` block. The same migrations and code run on both.

## 5. Without Docker

```bash
npm ci && npm run build
cd backend && cp .env.example .env    # set DB_CLIENT, PUBLIC_ORIGIN, COOKIE_SECURE=true, TRUST_PROXY=1, VAPID_*
SERVE_STATIC_DIR=../frontend/dist node --env-file=.env dist/server.js
```

Put Caddy or nginx in front for TLS (see `deploy/Caddyfile`). Install
`ffmpeg` for video thumbnails. Run it under systemd or similar.

## 6. Updating

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically at start-up. Back up first.

## Backups

`scripts/backup.sh` creates `backups/<timestamp>/` containing:

- `database.dump` (PostgreSQL custom format via `pg_dump`) or
  `database.sqlite` (online SQLite backup),
- `storage.tar.gz` (photos, videos, documents, thumbnails),
- `SHA256SUMS`.

```bash
./scripts/backup.sh
BACKUP_DIR=/mnt/external ./scripts/backup.sh --encrypt   # GnuPG AES-256, asks for a passphrase
./scripts/restore.sh backups/20260101-120000             # verifies checksums, asks for confirmation
```

Nothing is sent to third-party services. Schedule it with cron, e.g.
`0 3 * * * cd /opt/private-communication && ./scripts/backup.sh >> backups/backup.log 2>&1`,
and copy backups to an external disk you control. Test a restore now and then.

## What is stored where

| Data | Location |
| --- | --- |
| Database | `db-data` volume (PostgreSQL) or `/data/db` (SQLite) |
| Uploaded files | `storage` volume → `/data/storage/{photos,videos,documents,thumbnails}` |
| TLS certificates | `caddy-data` volume |
| Secrets | `.env` (never committed) |

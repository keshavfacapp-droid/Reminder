#!/usr/bin/env bash
# Local backup of the database and all uploaded files (photos, videos,
# documents, thumbnails). Nothing is uploaded anywhere — copy the resulting
# folder to a disk you control.
#
#   ./scripts/backup.sh                 # writes ./backups/<timestamp>/
#   BACKUP_DIR=/mnt/usb ./scripts/backup.sh
#   ./scripts/backup.sh --encrypt       # additionally encrypt with GnuPG (symmetric)
set -euo pipefail

cd "$(dirname "$0")/.."
ENCRYPT=false
[[ "${1:-}" == "--encrypt" ]] && ENCRYPT=true

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR:-./backups}/${STAMP}"
umask 077
mkdir -p "$OUT"

echo "→ Backing up to $OUT"

DB_CLIENT="$(docker compose exec -T backend printenv DB_CLIENT 2>/dev/null || echo postgres)"
if [[ "$DB_CLIENT" == "sqlite" ]]; then
  echo "→ SQLite database"
  docker compose exec -T backend node dist/scripts/backup-sqlite.js /tmp/backup.db >/dev/null
  docker compose cp backend:/tmp/backup.db "$OUT/database.sqlite"
  docker compose exec -T backend rm -f /tmp/backup.db
else
  echo "→ PostgreSQL database"
  docker compose exec -T db pg_dump -U private_space -d private_space --format=custom --no-owner > "$OUT/database.dump"
fi

echo "→ Files (photos, videos, documents, thumbnails)"
docker compose exec -T backend tar -C /data -czf - --exclude=storage/tmp storage > "$OUT/storage.tar.gz"

if $ENCRYPT; then
  echo "→ Encrypting (you will be asked for a passphrase)"
  for f in "$OUT"/*; do
    gpg --batch --yes --symmetric --cipher-algo AES256 --pinentry-mode loopback -o "$f.gpg" "$f" && shred -u "$f" 2>/dev/null || rm -f "$f"
  done
fi

(cd "$OUT" && sha256sum ./* > SHA256SUMS)
echo "✓ Backup complete: $OUT"
ls -lh "$OUT"

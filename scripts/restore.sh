#!/usr/bin/env bash
# Restores a backup created by scripts/backup.sh. THIS REPLACES ALL CURRENT DATA.
#
#   ./scripts/restore.sh ./backups/20250101-120000
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="${1:?Usage: restore.sh <backup-folder>}"
[[ -d "$SRC" ]] || { echo "No such folder: $SRC"; exit 1; }

(cd "$SRC" && sha256sum -c SHA256SUMS)

for f in "$SRC"/*.gpg; do
  [[ -e "$f" ]] || continue
  echo "→ Decrypting $(basename "$f")"
  gpg --batch --yes --pinentry-mode loopback -o "${f%.gpg}" -d "$f"
done

read -r -p "This will REPLACE the current database and files. Type 'restore' to continue: " answer
[[ "$answer" == "restore" ]] || { echo "Aborted."; exit 1; }

docker compose up -d db backend

if [[ -f "$SRC/database.dump" ]]; then
  echo "→ Restoring PostgreSQL"
  docker compose stop backend
  docker compose exec -T db pg_restore -U private_space -d private_space --clean --if-exists --no-owner < "$SRC/database.dump"
  docker compose start backend
elif [[ -f "$SRC/database.sqlite" ]]; then
  echo "→ Restoring SQLite"
  DB_PATH="$(docker compose exec -T backend printenv SQLITE_PATH)"
  docker compose cp "$SRC/database.sqlite" "backend:${DB_PATH}.restore"
  docker compose exec -T backend sh -c "mv '${DB_PATH}.restore' '$DB_PATH' && rm -f '${DB_PATH}-wal' '${DB_PATH}-shm'"
  docker compose restart backend
fi

echo "→ Restoring files"
docker compose exec -T backend sh -c 'find /data/storage -mindepth 1 -delete'
docker compose exec -T backend tar -C /data -xzf - < "$SRC/storage.tar.gz"

echo "✓ Restore complete."

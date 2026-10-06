/**
 * Consistent online backup of the SQLite database (safe while the server runs).
 *
 *   node dist/scripts/backup-sqlite.js /path/to/output.db
 */
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';

const config = loadConfig();
const dest = process.argv[2];
if (config.db.client !== 'sqlite') {
  console.error('DB_CLIENT is not sqlite; use pg_dump for PostgreSQL (see scripts/backup.sh).');
  process.exit(1);
}
if (!dest) {
  console.error('Usage: backup-sqlite <output-file>');
  process.exit(1);
}
const db = new Database(config.db.sqlitePath, { readonly: true, fileMustExist: true });
try {
  await db.backup(dest);
  console.log(`SQLite backup written to ${dest}`);
} finally {
  db.close();
}

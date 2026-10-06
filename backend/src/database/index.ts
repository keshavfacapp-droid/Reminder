import fs from 'node:fs';
import path from 'node:path';
import knexFactory, { type Knex } from 'knex';
import pg from 'pg';
import type { Config } from '../config.js';
import { migrationSource } from './migrations.js';

// Timestamps are stored as BIGINT epoch milliseconds so that SQLite and
// PostgreSQL behave identically. node-postgres returns BIGINT as a string by
// default; parse it to a number (epoch-ms values are well within 2^53).
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

export type Db = Knex;

export function createDb(config: Config): Db {
  if (config.db.client === 'postgres') {
    if (!config.db.url) throw new Error('DATABASE_URL is required when DB_CLIENT=postgres');
    return knexFactory({
      client: 'pg',
      connection: config.db.url,
      pool: { min: 0, max: 10 },
    });
  }

  if (config.db.sqlitePath !== ':memory:') {
    fs.mkdirSync(path.dirname(config.db.sqlitePath), { recursive: true });
  }
  return knexFactory({
    client: 'better-sqlite3',
    connection: { filename: config.db.sqlitePath },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (conn: { pragma: (s: string) => unknown }, done: (err: Error | null, conn: unknown) => void) => {
        conn.pragma('journal_mode = WAL');
        conn.pragma('foreign_keys = ON');
        conn.pragma('busy_timeout = 5000');
        done(null, conn);
      },
    },
  });
}

export async function migrate(db: Db): Promise<void> {
  await db.migrate.latest({ migrationSource });
}

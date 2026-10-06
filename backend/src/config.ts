import path from 'node:path';

export type DbClient = 'sqlite' | 'postgres';

export interface Config {
  env: string;
  host: string;
  port: number;
  db: {
    client: DbClient;
    url?: string;
    sqlitePath: string;
  };
  storageDir: string;
  publicOrigin?: string;
  trustProxy: number;
  cookieSecure: boolean;
  session: {
    idleTtlMs: number;
    absoluteTtlMs: number;
  };
  argon2: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  uploads: {
    maxPhotoBytes: number;
    maxVideoBytes: number;
    maxDocumentBytes: number;
  };
  vapid: {
    publicKey?: string;
    privateKey?: string;
    subject: string;
  };
  linkPreviews: boolean;
  serveStaticDir?: string;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid integer config value: ${value}`);
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

const MB = 1024 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const client = (env.DB_CLIENT ?? 'sqlite').toLowerCase();
  if (client !== 'sqlite' && client !== 'postgres') {
    throw new Error('DB_CLIENT must be "sqlite" or "postgres"');
  }
  const storageDir = path.resolve(env.STORAGE_DIR ?? path.join(process.cwd(), '..', 'storage'));

  return {
    env: env.NODE_ENV ?? 'development',
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 3000),
    db: {
      client,
      url: env.DATABASE_URL,
      sqlitePath: path.resolve(env.SQLITE_PATH ?? path.join(process.cwd(), '..', 'data', 'private-space.db')),
    },
    storageDir,
    publicOrigin: env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : undefined,
    trustProxy: int(env.TRUST_PROXY, 0),
    cookieSecure: bool(env.COOKIE_SECURE, true),
    session: {
      idleTtlMs: int(env.SESSION_IDLE_HOURS, 24 * 7) * 60 * 60 * 1000,
      absoluteTtlMs: int(env.SESSION_ABSOLUTE_DAYS, 30) * 24 * 60 * 60 * 1000,
    },
    argon2: {
      // OWASP-recommended Argon2id parameters (64 MiB, 3 iterations).
      memoryCost: int(env.ARGON2_MEMORY_KIB, 65536),
      timeCost: int(env.ARGON2_TIME_COST, 3),
      parallelism: int(env.ARGON2_PARALLELISM, 1),
    },
    uploads: {
      maxPhotoBytes: int(env.MAX_PHOTO_MB, 30) * MB,
      maxVideoBytes: int(env.MAX_VIDEO_MB, 500) * MB,
      maxDocumentBytes: int(env.MAX_DOCUMENT_MB, 100) * MB,
    },
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || undefined,
      privateKey: env.VAPID_PRIVATE_KEY || undefined,
      subject: env.VAPID_SUBJECT || 'mailto:admin@localhost',
    },
    linkPreviews: bool(env.LINK_PREVIEWS, true),
    serveStaticDir: env.SERVE_STATIC_DIR ? path.resolve(env.SERVE_STATIC_DIR) : undefined,
  };
}

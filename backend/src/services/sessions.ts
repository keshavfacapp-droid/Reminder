import crypto from 'node:crypto';
import type { Db } from '../database/index.js';
import type { Config } from '../config.js';
import type { User } from './users.js';

export interface SessionInfo {
  id: string;
  user: User;
  csrfToken: string;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly ttl: Config['session'],
  ) {}

  /** Creates a new session and returns the raw token for the cookie. */
  async create(userId: number): Promise<{ token: string; csrfToken: string; expiresAt: number; absoluteExpiresAt: number }> {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    const now = Date.now();
    const absolute = now + this.ttl.absoluteTtlMs;
    const expiresAt = Math.min(now + this.ttl.idleTtlMs, absolute);
    await this.db('sessions').insert({
      id: sha256(token),
      user_id: userId,
      csrf_token: csrfToken,
      created_at: now,
      expires_at: expiresAt,
      absolute_expires_at: absolute,
    });
    return { token, csrfToken, expiresAt, absoluteExpiresAt: absolute };
  }

  /**
   * Resolves a raw cookie token into a session. Expired sessions are deleted.
   * Only users that are among the authorised users are accepted.
   */
  async resolve(token: string | undefined, authorizedIds: number[]): Promise<SessionInfo | null> {
    if (!token || token.length > 128) return null;
    const id = sha256(token);
    const row = await this.db('sessions')
      .join('users', 'users.id', 'sessions.user_id')
      .where('sessions.id', id)
      .first('sessions.id', 'sessions.user_id', 'sessions.csrf_token', 'sessions.expires_at', 'sessions.absolute_expires_at', 'users.username');
    if (!row) return null;

    const now = Date.now();
    if (Number(row.expires_at) <= now || Number(row.absolute_expires_at) <= now) {
      await this.db('sessions').where({ id }).delete();
      return null;
    }
    const userId = Number(row.user_id);
    if (!authorizedIds.includes(userId)) return null;

    // Sliding idle expiry, capped by the absolute expiry.
    const newExpiry = Math.min(now + this.ttl.idleTtlMs, Number(row.absolute_expires_at));
    if (newExpiry - Number(row.expires_at) > REFRESH_THRESHOLD_MS) {
      await this.db('sessions').where({ id }).update({ expires_at: newExpiry });
    }
    return { id, user: { id: userId, username: row.username }, csrfToken: row.csrf_token };
  }

  async destroy(sessionId: string): Promise<void> {
    await this.db('sessions').where({ id: sessionId }).delete();
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    return this.db('sessions').where('expires_at', '<=', now).orWhere('absolute_expires_at', '<=', now).delete();
  }
}

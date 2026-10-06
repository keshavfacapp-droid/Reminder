import type { Db } from '../database/index.js';
import { PasswordHasher, validatePasswordStrength } from './passwords.js';

export const MAX_USERS = 2;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,64}$/;

export interface User {
  id: number;
  username: string;
}

export class UserService {
  constructor(
    private readonly db: Db,
    private readonly hasher: PasswordHasher,
  ) {}

  async count(): Promise<number> {
    const row = await this.db('users').count<{ c: number | string }[]>({ c: '*' }).first();
    return Number(row?.c ?? 0);
  }

  /**
   * Creates one of the two authorised users. Registration is impossible once
   * two users exist — there is no HTTP endpoint for this; it is only reachable
   * from the administrator CLI.
   */
  async create(username: string, password: string): Promise<User> {
    if (!USERNAME_RE.test(username)) {
      throw new Error('Username must be 3-64 characters: letters, digits, "_", "." or "-".');
    }
    const weak = validatePasswordStrength(password);
    if (weak) throw new Error(weak);
    const passwordHash = await this.hasher.hash(password);

    return this.db.transaction(async (trx) => {
      const row = await trx('users').count<{ c: number | string }[]>({ c: '*' }).first();
      if (Number(row?.c ?? 0) >= MAX_USERS) {
        throw new Error(`This space already has ${MAX_USERS} users. Registration is closed.`);
      }
      const existing = await trx('users').where({ username }).first();
      if (existing) throw new Error('That username is already taken.');
      const [inserted] = await trx('users')
        .insert({ username, password_hash: passwordHash, created_at: Date.now() })
        .returning<{ id: number }[]>('id');
      return { id: Number(inserted.id), username };
    });
  }

  async setPassword(username: string, password: string): Promise<void> {
    const weak = validatePasswordStrength(password);
    if (weak) throw new Error(weak);
    const user = await this.db('users').where({ username }).first();
    if (!user) throw new Error('No such user.');
    const passwordHash = await this.hasher.hash(password);
    await this.db.transaction(async (trx) => {
      await trx('users').where({ id: user.id }).update({ password_hash: passwordHash });
      // Invalidate every existing session for that user.
      await trx('sessions').where({ user_id: user.id }).delete();
    });
  }

  findByUsername(username: string): Promise<{ id: number; username: string; password_hash: string } | undefined> {
    return this.db('users').where({ username }).first();
  }

  /** IDs of the (at most two) authorised users, in creation order. */
  async authorizedIds(): Promise<number[]> {
    const rows = await this.db('users').select('id').orderBy('id', 'asc').limit(MAX_USERS);
    return rows.map((r: { id: number }) => Number(r.id));
  }

  async otherUserId(userId: number): Promise<number | undefined> {
    const ids = await this.authorizedIds();
    return ids.find((id) => id !== userId);
  }

  async touchLastSeen(userId: number): Promise<void> {
    await this.db('users').where({ id: userId }).update({ last_seen: Date.now() });
  }
}

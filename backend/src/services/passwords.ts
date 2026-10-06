import argon2 from 'argon2';
import type { Config } from '../config.js';

export class PasswordHasher {
  private dummyHash: Promise<string>;

  constructor(private readonly params: Config['argon2']) {
    // Used to keep login timing constant when the username does not exist.
    this.dummyHash = this.hash('dummy-password-for-timing-equalisation');
  }

  hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.params.memoryCost,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
    });
  }

  async verify(hash: string | undefined, password: string): Promise<boolean> {
    try {
      if (!hash) {
        await argon2.verify(await this.dummyHash, password);
        return false;
      }
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

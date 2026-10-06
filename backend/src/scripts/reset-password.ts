/**
 * Sets a new password for an existing user and signs out all their sessions.
 *
 *   npm run reset-password -w backend -- <username>
 *   docker compose exec backend node dist/scripts/reset-password.js <username>
 */
import { loadConfig } from '../config.js';
import { createDb, migrate } from '../database/index.js';
import { PasswordHasher } from '../services/passwords.js';
import { UserService } from '../services/users.js';
import { askNewPassword, prompt } from './prompt.js';

const config = loadConfig();
const db = createDb(config);
try {
  await migrate(db);
  const users = new UserService(db, new PasswordHasher(config.argon2));
  const username = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? (await prompt('Username: '));
  await users.setPassword(username.trim(), await askNewPassword());
  console.log('Password updated. All existing sessions for this user were signed out.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}

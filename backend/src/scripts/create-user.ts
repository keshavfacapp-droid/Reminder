/**
 * Administrator setup: creates one of the two authorised users.
 *
 *   npm run create-user -w backend -- <username>
 *   docker compose exec backend node dist/scripts/create-user.js <username>
 *
 * There is intentionally no web registration. Once two users exist this
 * command refuses to create more.
 */
import { loadConfig } from '../config.js';
import { createDb, migrate } from '../database/index.js';
import { PasswordHasher } from '../services/passwords.js';
import { MAX_USERS, UserService } from '../services/users.js';
import { askNewPassword, prompt } from './prompt.js';

const config = loadConfig();
const db = createDb(config);
try {
  await migrate(db);
  const users = new UserService(db, new PasswordHasher(config.argon2));
  const count = await users.count();
  if (count >= MAX_USERS) {
    console.error(`This space already has ${MAX_USERS} users. Registration is closed.`);
    process.exitCode = 1;
  } else {
    const username = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? (await prompt('Username: '));
    const password = await askNewPassword();
    const user = await users.create(username.trim(), password);
    console.log(`Created user #${user.id} (${count + 1}/${MAX_USERS}).`);
    if (count + 1 >= MAX_USERS) console.log('Both users exist. Registration is now permanently closed.');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}

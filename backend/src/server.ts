import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { server, ctx, close } = await createApp(config);

const userCount = await ctx.users.count();
server.listen(config.port, config.host, () => {
  console.log(`[private-space] listening on ${config.host}:${config.port} (db: ${config.db.client})`);
  if (userCount < 2) {
    console.log(`[private-space] ${userCount}/2 users exist. Create them with: npm run create-user (see README).`);
  }
  if (!ctx.push.enabled) {
    console.log('[private-space] Web Push disabled: set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (npm run generate-vapid).');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close().finally(() => process.exit(0));
  });
}

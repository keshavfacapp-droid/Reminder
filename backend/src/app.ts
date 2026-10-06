import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { Config } from './config.js';
import { createDb, migrate, type Db } from './database/index.js';
import { originCheck, requireAuth, requireCsrf } from './middleware/auth.js';
import { errorHandler } from './middleware/errors.js';
import { authRoutes } from './routes/auth.js';
import { fileRoutes } from './routes/files.js';
import { messageRoutes } from './routes/messages.js';
import { pushRoutes } from './routes/push.js';
import { MessageService } from './services/messages.js';
import { PasswordHasher } from './services/passwords.js';
import { PushService, type PushSender } from './services/push.js';
import { RealtimeHub } from './services/realtime.js';
import { SessionService } from './services/sessions.js';
import { StorageService } from './services/storage.js';
import { UserService } from './services/users.js';

export interface AppContext {
  config: Config;
  db: Db;
  hasher: PasswordHasher;
  users: UserService;
  sessions: SessionService;
  storage: StorageService;
  messages: MessageService;
  push: PushService;
  hub: RealtimeHub;
  requireAuth: RequestHandler;
  markRead(userId: number, upToId: number): Promise<{ ids: number[]; readAt: number }>;
}

export interface CreatedApp {
  app: express.Express;
  server: http.Server;
  ctx: AppContext;
  close(): Promise<void>;
}

export async function createApp(config: Config, options: { pushSender?: PushSender } = {}): Promise<CreatedApp> {
  const db = createDb(config);
  await migrate(db);

  const hasher = new PasswordHasher(config.argon2);
  const users = new UserService(db, hasher);
  const sessions = new SessionService(db, config.session);
  const storage = new StorageService(config);
  const messages = new MessageService(db, storage);
  const push = new PushService(db, config, options.pushSender);
  const hub = new RealtimeHub(config, sessions, users);

  const ctx: AppContext = {
    config,
    db,
    hasher,
    users,
    sessions,
    storage,
    messages,
    push,
    hub,
    requireAuth: requireAuth(config, sessions, users),
    async markRead(userId, upToId) {
      const result = await messages.markRead(userId, upToId);
      if (result.ids.length) hub.broadcast(() => ({ type: 'message:read', ids: result.ids, readAt: result.readAt }));
      return result;
    },
  };
  hub.onRead = (userId, upToId) => void ctx.markRead(userId, upToId).catch(() => undefined);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'blob:', 'data:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'", ...(config.publicOrigin ? [config.publicOrigin.replace(/^http/, 'ws')] : [])],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: config.cookieSecure ? { maxAge: 31536000 } : false,
    }),
  );
  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=(), interest-cohort=()');
    next();
  });
  app.use(cookieParser());
  app.use('/api', express.json({ limit: '64kb' }));
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );
  app.use('/api', originCheck(config));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRoutes(ctx));

  // Everything below requires an authenticated, authorised user + CSRF token.
  const privateApi = express.Router();
  privateApi.use(ctx.requireAuth, requireCsrf);
  privateApi.use(messageRoutes(ctx));
  privateApi.use(fileRoutes(ctx));
  privateApi.use(pushRoutes(ctx));
  app.use('/api', privateApi);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Optional: serve the built frontend directly (single-container deployments).
  if (config.serveStaticDir && fs.existsSync(config.serveStaticDir)) {
    const dir = config.serveStaticDir;
    app.use(
      express.static(dir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith('service-worker.js') || filePath.endsWith('manifest.json')) {
            res.set('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    app.get(/^(?!\/api\/|\/ws$).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(dir, 'index.html'));
    });
  }

  app.use(errorHandler);

  const server = http.createServer(app);
  hub.attach(server);

  const timers = [
    setInterval(() => void sessions.purgeExpired().catch(() => undefined), 60 * 60 * 1000),
    setInterval(() => void storage.cleanTmp().catch(() => undefined), 60 * 60 * 1000),
  ];
  for (const t of timers) t.unref();

  return {
    app,
    server,
    ctx,
    async close() {
      for (const t of timers) clearInterval(t);
      hub.close();
      await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
      await db.destroy();
    },
  };
}

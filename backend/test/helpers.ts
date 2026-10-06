import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp, type CreatedApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { PushSender } from '../src/services/push.js';

export const PASSWORD_A = 'correct horse battery staple';
export const PASSWORD_B = 'another long passphrase!';

export interface SentPush {
  endpoint: string;
  payload: string;
  options: unknown;
}

export interface TestEnv {
  app: CreatedApp;
  config: Config;
  baseUrl: string;
  origin: string;
  tmp: string;
  pushes: SentPush[];
  userA: { id: number; username: string };
  userB: { id: number; username: string };
  close(): Promise<void>;
}

export async function setup(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_CLIENT: process.env.TEST_DB_CLIENT ?? 'sqlite',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    SQLITE_PATH: path.join(tmp, 'test.db'),
    STORAGE_DIR: path.join(tmp, 'storage'),
    COOKIE_SECURE: 'false',
    ARGON2_MEMORY_KIB: '8192',
    ARGON2_TIME_COST: '2',
    VAPID_PUBLIC_KEY: 'BPUBLIC',
    VAPID_PRIVATE_KEY: 'private',
    LINK_PREVIEWS: 'false',
    ...overrides,
  });
  const pushes: SentPush[] = [];
  const sender: PushSender = {
    async sendNotification(sub, payload, options) {
      pushes.push({ endpoint: sub.endpoint, payload, options });
      return {};
    },
  };
  const app = await createApp(config, { pushSender: sender });
  if (config.db.client === 'postgres') {
    await app.ctx.db.raw('TRUNCATE push_subscriptions, messages, sessions, users RESTART IDENTITY CASCADE');
  }
  const userA = await app.ctx.users.create('alpha', PASSWORD_A);
  const userB = await app.ctx.users.create('bravo', PASSWORD_B);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    config,
    baseUrl,
    origin: baseUrl,
    tmp,
    pushes,
    userA,
    userB,
    async close() {
      await app.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  cookie: string;
  get(url: string): request.Test;
  post(url: string, body?: object): request.Test;
  del(url: string): request.Test;
  upload(kind: string, file: Buffer, filename: string, caption?: string): request.Test;
}

export async function login(env: TestEnv, username: string, password: string): Promise<Client> {
  const agent = request.agent(env.baseUrl);
  const res = await agent.post('/api/auth/login').set('Origin', env.origin).send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const csrf = res.body.csrfToken as string;
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return {
    agent,
    csrf,
    cookie,
    get: (url) => agent.get(url),
    post: (url, body = {}) => agent.post(url).set('Origin', env.origin).set('X-CSRF-Token', csrf).send(body),
    del: (url) => agent.delete(url).set('Origin', env.origin).set('X-CSRF-Token', csrf),
    upload: (kind, file, filename, caption) => {
      const r = agent
        .post('/api/messages/upload')
        .set('Origin', env.origin)
        .set('X-CSRF-Token', csrf)
        .field('kind', kind);
      if (caption) r.field('caption', caption);
      return r.attach('file', file, filename);
    },
  };
}

export async function loginBoth(env: TestEnv): Promise<[Client, Client]> {
  return [await login(env, 'alpha', PASSWORD_A), await login(env, 'bravo', PASSWORD_B)];
}

export function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)],
  );
}

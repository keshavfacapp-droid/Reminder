import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginBoth, setup, type Client, type TestEnv } from './helpers.js';
import { PDF, png } from './fixtures.js';
import { NOTIFICATION_TITLE, PUSH_PAYLOAD, type PushSender } from '../src/services/push.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.resolve(here, '../../frontend/public/service-worker.js');

let env: TestEnv;
let a: Client;
let b: Client;
const SUB_A = { endpoint: 'https://push.example.org/device-a', keys: { p256dh: 'AAAAAAAAAAAAAAAA', auth: 'aaaaaaaaaaaa' } };
const SUB_B = { endpoint: 'https://push.example.org/device-b', keys: { p256dh: 'BBBBBBBBBBBBBBBB', auth: 'bbbbbbbbbbbb' } };

beforeEach(async () => {
  env = await setup();
  [a, b] = await loginBoth(env);
  await a.post('/api/push/subscribe', SUB_A).expect(201);
  await b.post('/api/push/subscribe', SUB_B).expect(201);
});
afterEach(async () => {
  await env.close();
});

const settle = () => new Promise((r) => setTimeout(r, 100));
const FORBIDDEN = ['alpha', 'bravo', 'secret', 'holiday', '.png', '.pdf', 'example.com', 'message', 'sent'];

function assertOnlyReminder(payload: string) {
  expect(payload).toBe(JSON.stringify({ title: 'Reminder' }));
  for (const word of FORBIDDEN) expect(payload.toLowerCase()).not.toContain(word);
}

describe('server-side push', () => {
  it('the constant notification title is exactly "Reminder"', () => {
    expect(NOTIFICATION_TITLE).toBe('Reminder');
    expect(JSON.parse(PUSH_PAYLOAD)).toEqual({ title: 'Reminder' });
  });

  it('a text message notifies only the recipient, with a content-free payload', async () => {
    await a.post('/api/messages', { text: 'secret plans https://example.com' }).expect(201);
    await settle();
    expect(env.pushes).toHaveLength(1);
    expect(env.pushes[0].endpoint).toBe(SUB_B.endpoint);
    assertOnlyReminder(env.pushes[0].payload);
    expect(env.pushes[0].options).toMatchObject({ topic: 'reminder' });
  });

  it('photo, document and link messages carry no preview either', async () => {
    await b.upload('photo', await png(), 'holiday.png', 'secret caption').expect(201);
    await b.upload('document', PDF, 'secret.pdf').expect(201);
    await b.post('/api/messages/link', { url: 'https://example.com/secret' }).expect(201);
    await settle();
    expect(env.pushes).toHaveLength(3);
    for (const p of env.pushes) {
      expect(p.endpoint).toBe(SUB_A.endpoint);
      assertOnlyReminder(p.payload);
    }
  });

  it('does not notify while the recipient is actively viewing the app', async () => {
    const ws = new WebSocket(`${env.baseUrl.replace('http', 'ws')}/ws`, { headers: { Cookie: b.cookie, Origin: env.origin } });
    await new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'visibility', visible: true }));
    await settle();
    await a.post('/api/messages', { text: 'hello' });
    await settle();
    expect(env.pushes).toHaveLength(0);

    ws.send(JSON.stringify({ type: 'visibility', visible: false }));
    await settle();
    await a.post('/api/messages', { text: 'hello again' });
    await settle();
    expect(env.pushes).toHaveLength(1);
    ws.close();
  });

  it('removes subscriptions the push service reports as gone', async () => {
    (env.app.ctx.push as unknown as { sender: PushSender }).sender = {
      async sendNotification() {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      },
    };
    await a.post('/api/messages', { text: 'x' });
    await settle();
    expect(await env.app.ctx.db('push_subscriptions').where({ user_id: env.userB.id })).toHaveLength(0);
  });
});

describe('service worker notification', () => {
  type Listener = (event: unknown) => void;

  function loadServiceWorker() {
    const listeners: Record<string, Listener[]> = {};
    const shown: { title: string; options: Record<string, unknown> }[] = [];
    const self = {
      location: { origin: 'https://space.example' },
      addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
      registration: {
        showNotification: async (title: string, options: Record<string, unknown>) => {
          shown.push({ title, options: { ...options } });
        },
      },
      clients: { matchAll: async () => [], openWindow: async () => undefined, claim: async () => undefined },
      skipWaiting: async () => undefined,
    };
    vm.runInNewContext(fs.readFileSync(SW_PATH, 'utf8'), { self, caches: {}, fetch: () => undefined, URL, Promise, Object });

    const push = async (data: unknown) => {
      const pending: Promise<unknown>[] = [];
      for (const fn of listeners.push ?? []) fn({ data, waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
    };
    return { push, shown };
  }

  const fakeData = (text: string) => ({ text: () => text, json: () => JSON.parse(text) });

  it('always shows exactly "Reminder" and nothing else, whatever the payload', async () => {
    const sw = loadServiceWorker();
    const payloads = [
      null,
      fakeData(PUSH_PAYLOAD),
      fakeData(JSON.stringify({ title: 'Keshav sent you a message', body: 'Hey, how was your day?', icon: '/photo.jpg', image: '/photo.jpg' })),
      fakeData('You have a new message'),
      fakeData('not json at all'),
    ];
    for (const p of payloads) await sw.push(p);

    expect(sw.shown).toHaveLength(payloads.length);
    for (const n of sw.shown) {
      expect(n.title).toBe('Reminder');
      // No body, no icon, no image, no actions, no data — only grouping flags.
      expect(Object.keys(n.options).sort()).toEqual(['renotify', 'tag']);
      expect(n.options).toEqual({ tag: 'reminder', renotify: true });
    }
  });

  it('the service worker source never reads the push payload', () => {
    const src = fs.readFileSync(SW_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/event\.data|\.json\(\)|\.text\(\)|body\s*:/);
    expect(src.match(/showNotification\(/g)).toHaveLength(1);
  });
});

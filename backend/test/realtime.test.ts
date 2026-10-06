import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginBoth, setup, type Client, type TestEnv } from './helpers.js';

let env: TestEnv;
let a: Client;
let b: Client;
beforeEach(async () => {
  env = await setup();
  [a, b] = await loginBoth(env);
});
afterEach(async () => {
  await env.close();
});

function connect(headers: Record<string, string>): Promise<{ ws: WebSocket; events: any[] } | { status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${env.baseUrl.replace('http', 'ws')}/ws`, { headers });
    const events: any[] = [];
    ws.on('message', (d) => events.push(JSON.parse(String(d))));
    ws.once('open', () => setTimeout(() => resolve({ ws, events }), 50));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once('error', () => undefined);
  });
}

const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('WebSocket channel', () => {
  it('rejects connections without a valid session', async () => {
    expect(await connect({ Origin: env.origin })).toEqual({ status: 401 });
    expect(await connect({ Origin: env.origin, Cookie: 'ps_session=forged' })).toEqual({ status: 401 });
  });

  it('rejects cross-site WebSocket hijacking', async () => {
    expect(await connect({ Origin: 'https://evil.example', Cookie: b.cookie })).toEqual({ status: 403 });
    expect(await connect({ Cookie: b.cookie })).toEqual({ status: 403 });
  });

  it('delivers new messages, read receipts and deletions in real time', async () => {
    const conn = await connect({ Origin: env.origin, Cookie: b.cookie });
    const sender = await connect({ Origin: env.origin, Cookie: a.cookie });
    if (!('ws' in conn) || !('ws' in sender)) throw new Error('connect failed');

    const { body } = await a.post('/api/messages', { text: 'live!' });
    await wait();
    const received = conn.events.find((e) => e.type === 'message:new');
    expect(received.message).toMatchObject({ text: 'live!', mine: false, readAt: null });
    expect(sender.events.find((e) => e.type === 'message:new').message.mine).toBe(true);

    conn.ws.send(JSON.stringify({ type: 'read', upToId: body.message.id }));
    await wait();
    expect(sender.events.find((e) => e.type === 'message:read').ids).toEqual([body.message.id]);

    await a.del(`/api/messages/${body.message.id}`);
    await wait();
    expect(conn.events.find((e) => e.type === 'message:deleted')).toEqual({ type: 'message:deleted', id: body.message.id });
    conn.ws.close();
    sender.ws.close();
  });

  it('closes sockets when the session logs out', async () => {
    const conn = await connect({ Origin: env.origin, Cookie: b.cookie });
    if (!('ws' in conn)) throw new Error('connect failed');
    const closed = new Promise<number>((r) => conn.ws.once('close', (code) => r(code)));
    await b.post('/api/auth/logout');
    expect(await closed).toBe(4001);
  });

  it('ignores malformed client frames', async () => {
    const conn = await connect({ Origin: env.origin, Cookie: b.cookie });
    if (!('ws' in conn)) throw new Error('connect failed');
    conn.ws.send('not json');
    conn.ws.send(JSON.stringify({ type: 'read', upToId: 'DROP TABLE' }));
    conn.ws.send(JSON.stringify({ type: 'read', upToId: -5 }));
    await wait();
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
  });
});

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login, loginBoth, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

const PRIVATE_GETS = [
  '/api/messages',
  '/api/messages/unread-count',
  '/api/shared?type=photo',
  '/api/shared?type=link',
  '/api/files/1/original',
  '/api/files/1/thumb',
  '/api/push/config',
  '/api/auth/session',
];
const PRIVATE_POSTS = ['/api/messages', '/api/messages/link', '/api/messages/upload', '/api/messages/read', '/api/push/subscribe', '/api/push/unsubscribe'];

describe('unauthorised access', () => {
  it('rejects every private endpoint without a session', async () => {
    const [a] = await loginBoth(env);
    await a.post('/api/messages', { text: 'secret' }).expect(201);
    for (const path of PRIVATE_GETS) {
      const res = await request(env.baseUrl).get(path);
      expect(res.status, path).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
    for (const path of PRIVATE_POSTS) {
      expect((await request(env.baseUrl).post(path).set('Origin', env.origin).send({})).status, path).toBe(401);
    }
    expect((await request(env.baseUrl).delete('/api/messages/1').set('Origin', env.origin)).status).toBe(401);
  });

  it('rejects forged / random session cookies', async () => {
    for (const cookie of ['ps_session=forged', 'ps_session=' + 'A'.repeat(43), 'ps_session=' + 'x'.repeat(5000)]) {
      expect((await request(env.baseUrl).get('/api/messages').set('Cookie', cookie)).status).toBe(401);
    }
  });

  it('a third account inserted behind the app’s back is not authorised', async () => {
    const hash = await env.app.ctx.hasher.hash('intruder password 123');
    await env.app.ctx.db('users').insert({ username: 'intruder', password_hash: hash, created_at: Date.now() });
    const res = await request(env.baseUrl)
      .post('/api/auth/login')
      .set('Origin', env.origin)
      .send({ username: 'intruder', password: 'intruder password 123' });
    expect(res.status).toBe(401);
    // Even with a session row, the user is not one of the two authorised users.
    const intruder = await env.app.ctx.db('users').where({ username: 'intruder' }).first();
    const s = await env.app.ctx.sessions.create(intruder.id);
    expect((await request(env.baseUrl).get('/api/messages').set('Cookie', `ps_session=${s.token}`)).status).toBe(401);
  });
});

describe('resource authorisation', () => {
  it('ignores sender IDs supplied by the client', async () => {
    const [a] = await loginBoth(env);
    const res = await a.post('/api/messages', { text: 'hi', senderId: env.userB.id, sender_id: env.userB.id });
    expect(res.status).toBe(201);
    const row = await env.app.ctx.db('messages').where({ id: res.body.message.id }).first();
    expect(row.sender_id).toBe(env.userA.id);
  });

  it('user B cannot delete user A’s message', async () => {
    const [a, b] = await loginBoth(env);
    const { body } = await a.post('/api/messages', { text: 'mine' });
    expect((await b.del(`/api/messages/${body.message.id}`)).status).toBe(403);
    expect((await a.del(`/api/messages/${body.message.id}`)).status).toBe(200);
    expect((await a.del(`/api/messages/${body.message.id}`)).status).toBe(404);
  });

  it('a user cannot mark their own messages as read', async () => {
    const [a, b] = await loginBoth(env);
    const { body } = await a.post('/api/messages', { text: 'unread' });
    await a.post('/api/messages/read', { upToId: body.message.id }).expect(200);
    expect((await env.app.ctx.db('messages').where({ id: body.message.id }).first()).read_at).toBeNull();
    await b.post('/api/messages/read', { upToId: body.message.id }).expect(200);
    expect((await env.app.ctx.db('messages').where({ id: body.message.id }).first()).read_at).not.toBeNull();
  });

  it('read status is reported to the sender', async () => {
    const [a, b] = await loginBoth(env);
    await a.post('/api/messages', { text: 'one' });
    const { body } = await a.post('/api/messages', { text: 'two' });
    expect((await b.get('/api/messages/unread-count')).body.count).toBe(2);
    await b.post('/api/messages/read', { upToId: body.message.id });
    expect((await b.get('/api/messages/unread-count')).body.count).toBe(0);
    const list = (await a.get('/api/messages')).body.messages;
    expect(list.every((m: { readAt: number | null; mine: boolean }) => m.mine && m.readAt)).toBe(true);
  });

  it('push subscriptions are bound to the session user', async () => {
    const [a, b] = await loginBoth(env);
    const sub = { endpoint: 'https://push.example.org/abc', keys: { p256dh: 'BBBBBBBBBBBB', auth: 'AAAAAAAAAA' } };
    await a.post('/api/push/subscribe', { ...sub, userId: env.userB.id }).expect(201);
    const row = await env.app.ctx.db('push_subscriptions').first();
    expect(row.user_id).toBe(env.userA.id);
    await b.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).expect(200);
    expect(Number((await env.app.ctx.db('push_subscriptions').count({ c: '*' }).first())!.c)).toBe(1);
  });

  it('rejects non-https push endpoints', async () => {
    const a = await login(env, 'alpha', 'correct horse battery staple');
    const res = await a.post('/api/push/subscribe', { endpoint: 'http://127.0.0.1/x', keys: { p256dh: 'BBBBBBBBBBBB', auth: 'AAAAAAAAAA' } });
    expect(res.status).toBe(400);
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the CSRF token', async () => {
    const a = await login(env, 'alpha', 'correct horse battery staple');
    const res = await a.agent.post('/api/messages').set('Origin', env.origin).send({ text: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf');
  });

  it('rejects a wrong CSRF token', async () => {
    const [a, b] = await loginBoth(env);
    const res = await a.agent.post('/api/messages').set('Origin', env.origin).set('X-CSRF-Token', b.csrf).send({ text: 'x' });
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin requests even with a valid token', async () => {
    const a = await login(env, 'alpha', 'correct horse battery staple');
    const res = await a.agent.post('/api/messages').set('Origin', 'https://evil.example').set('X-CSRF-Token', a.csrf).send({ text: 'x' });
    expect(res.status).toBe(403);
    const ref = await a.agent.post('/api/messages').set('Referer', 'https://evil.example/page').set('X-CSRF-Token', a.csrf).send({ text: 'x' });
    expect(ref.status).toBe(403);
    const nul = await a.agent.post('/api/messages').set('Origin', 'null').set('X-CSRF-Token', a.csrf).send({ text: 'x' });
    expect(nul.status).toBe(403);
  });

  it('rejects cross-origin login attempts', async () => {
    const res = await request(env.baseUrl)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ username: 'alpha', password: 'correct horse battery staple' });
    expect(res.status).toBe(403);
  });

  it('does not accept form-encoded bodies (no simple-request CSRF)', async () => {
    const a = await login(env, 'alpha', 'correct horse battery staple');
    const res = await a.agent
      .post('/api/messages')
      .set('Origin', env.origin)
      .set('X-CSRF-Token', a.csrf)
      .type('form')
      .send('text=hello');
    expect(res.status).toBe(400);
  });
});

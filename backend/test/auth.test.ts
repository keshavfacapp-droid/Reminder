import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login, PASSWORD_A, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

const loginReq = (body: object, origin?: string) =>
  request(env.baseUrl).post('/api/auth/login').set('Origin', origin ?? env.origin).send(body);

describe('authentication', () => {
  it('rejects an unknown user and a wrong password identically', async () => {
    const unknown = await loginReq({ username: 'nobody', password: 'whatever-password' });
    const wrong = await loginReq({ username: 'alpha', password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.headers['set-cookie']).toBeUndefined();
  });

  it('rejects malformed login bodies', async () => {
    expect((await loginReq({ username: ['alpha'], password: PASSWORD_A })).status).toBe(400);
    expect((await loginReq({ username: 'alpha', password: 'x'.repeat(1000) })).status).toBe(400);
  });

  it('issues an HttpOnly, SameSite=Strict session cookie', async () => {
    const res = await loginReq({ username: 'alpha', password: PASSWORD_A });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(res.body.csrfToken).toMatch(/^[\w-]{40,}$/);
  });

  it('uses a Secure __Host- cookie when COOKIE_SECURE is on', async () => {
    const secureEnv = await setup({ COOKIE_SECURE: 'true' });
    try {
      const res = await request(secureEnv.baseUrl)
        .post('/api/auth/login')
        .set('Origin', secureEnv.origin)
        .send({ username: 'alpha', password: PASSWORD_A });
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/^__Host-ps_session=/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/Path=\//);
    } finally {
      await secureEnv.close();
    }
  });

  it('stores only Argon2id hashes, never plain-text passwords', async () => {
    const rows = await env.app.ctx.db('users').select('password_hash');
    for (const r of rows) {
      expect(r.password_hash).toMatch(/^\$argon2id\$/);
      expect(r.password_hash).not.toContain(PASSWORD_A);
    }
  });

  it('does not store raw session tokens in the database', async () => {
    const c = await login(env, 'alpha', PASSWORD_A);
    const token = c.cookie.split('=')[1];
    const rows = await env.app.ctx.db('sessions').select('id');
    expect(rows.map((r) => r.id)).not.toContain(token);
  });

  it('expires sessions after the idle timeout', async () => {
    const c = await login(env, 'alpha', PASSWORD_A);
    expect((await c.get('/api/auth/session')).status).toBe(200);
    await env.app.ctx.db('sessions').update({ expires_at: Date.now() - 1000 });
    expect((await c.get('/api/auth/session')).status).toBe(401);
    expect(Number((await env.app.ctx.db('sessions').count({ c: '*' }).first())!.c)).toBe(0);
  });

  it('expires sessions after the absolute lifetime even if active', async () => {
    const c = await login(env, 'alpha', PASSWORD_A);
    await env.app.ctx.db('sessions').update({ absolute_expires_at: Date.now() - 1 });
    expect((await c.get('/api/messages')).status).toBe(401);
  });

  it('logout invalidates the session server-side', async () => {
    const c = await login(env, 'alpha', PASSWORD_A);
    const cookie = c.cookie;
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    const replay = await request(env.baseUrl).get('/api/messages').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  it('logout requires the CSRF token', async () => {
    const c = await login(env, 'alpha', PASSWORD_A);
    const res = await c.agent.post('/api/auth/logout').set('Origin', env.origin);
    expect(res.status).toBe(403);
  });

  it('locks a username after repeated failures', async () => {
    for (let i = 0; i < 5; i++) await loginReq({ username: 'alpha', password: `wrong-password-${i}` });
    const res = await loginReq({ username: 'alpha', password: PASSWORD_A });
    expect(res.status).toBe(429);
  });

  it('rate limits login attempts per IP', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await loginReq({ username: `user${i}`, password: 'wrong-password-x' })).status;
    expect(last).toBe(429);
  });

  it('issues a fresh session on every login (no fixation)', async () => {
    const a = await login(env, 'alpha', PASSWORD_A);
    const res = await a.agent.post('/api/auth/login').set('Origin', env.origin).send({ username: 'alpha', password: PASSWORD_A });
    const newCookie = String(res.headers['set-cookie']).split(';')[0];
    expect(newCookie).not.toEqual(a.cookie);
    const old = await request(env.baseUrl).get('/api/messages').set('Cookie', a.cookie);
    expect(old.status).toBe(401);
  });

  it('password reset signs out existing sessions', async () => {
    const c = await login(env, 'alpha', PASSWORD_A);
    await env.app.ctx.users.setPassword('alpha', 'a brand new passphrase');
    expect((await c.get('/api/messages')).status).toBe(401);
  });
});

describe('registration', () => {
  it('has no public registration endpoint', async () => {
    for (const path of ['/api/auth/register', '/api/register', '/api/users', '/api/auth/signup', '/api/setup']) {
      const res = await request(env.baseUrl).post(path).set('Origin', env.origin).send({ username: 'x', password: 'y' });
      expect([401, 404]).toContain(res.status);
    }
  });

  it('refuses to create a third user', async () => {
    await expect(env.app.ctx.users.create('charlie', 'yet another passphrase')).rejects.toThrow(/Registration is closed/);
  });

  it('rejects weak passwords and invalid usernames', async () => {
    await env.app.ctx.db('users').where({ username: 'bravo' }).delete();
    await expect(env.app.ctx.users.create('charlie', 'short')).rejects.toThrow(/at least 12/);
    await expect(env.app.ctx.users.create('../etc', 'long enough password')).rejects.toThrow(/Username/);
  });
});

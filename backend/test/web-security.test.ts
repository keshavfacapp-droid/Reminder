import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginBoth, setup, type Client, type TestEnv } from './helpers.js';
import { extractFirstUrl, fetchLinkMetadata, isPublicAddress, parseMetadata, sanitizeUrl } from '../src/services/links.js';
import { sanitizeFileName } from '../src/services/storage.js';

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

describe('XSS', () => {
  it('returns message text verbatim as JSON data (rendered as text by the client)', async () => {
    const payload = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    await a.post('/api/messages', { text: payload }).expect(201);
    const res = await b.get('/api/messages');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.messages[0].text).toBe(payload);
  });

  it('never accepts javascript:, data: or other non-http links', async () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', '//evil.example', 'https://user:pass@evil.example']) {
      expect((await a.post('/api/messages/link', { url })).status, url).toBe(400);
      expect(sanitizeUrl(url)).toBeNull();
    }
    const res = await a.post('/api/messages', { text: 'javascript:alert(1) and data:text/html,x' });
    expect(res.body.message.type).toBe('text');
    expect(res.body.message.link).toBeNull();
  });

  it('detects http(s) URLs inside messages', async () => {
    expect(extractFirstUrl('look: https://example.com/a?b=1.')).toBe('https://example.com/a?b=1');
    expect(extractFirstUrl('(see http://example.org)')).toBe('http://example.org/');
    const res = await a.post('/api/messages', { text: 'hi https://example.com' });
    expect(res.body.message).toMatchObject({ type: 'link', link: { url: 'https://example.com/', host: 'example.com' } });
  });

  it('link metadata is reduced to plain text', () => {
    const meta = parseMetadata(
      '<html><head><meta property="og:title" content="Hi &lt;script&gt;alert(1)&lt;/script&gt; there"><meta property="og:site_name" content="Ex&amp;ample"><title>t</title></head></html>',
    );
    expect(meta.title).toBe('Hi alert(1) there');
    expect(meta.site).toBe('Ex&ample');
  });

  it('sends a strict Content-Security-Policy', async () => {
    const res = await a.get('/api/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('..\\..\\windows\\system32\\evil.dll.pdf')).toBe('evil.dll.pdf');
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeFileName('...')).toBe('file');
    expect(sanitizeFileName('x'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(150);
  });
});

describe('SQL injection', () => {
  it('treats injection strings as data', async () => {
    const login = await request(env.baseUrl)
      .post('/api/auth/login')
      .set('Origin', env.origin)
      .send({ username: "' OR '1'='1' --", password: "' OR '1'='1' --" });
    expect(login.status).toBe(401);

    const evil = "'); DROP TABLE messages; --";
    await a.post('/api/messages', { text: evil }).expect(201);
    expect((await b.get('/api/messages')).body.messages[0].text).toBe(evil);
    expect(await env.app.ctx.db.schema.hasTable('messages')).toBe(true);
  });

  it('validates numeric parameters', async () => {
    expect((await a.get('/api/messages?before=1%20OR%201=1')).status).toBe(400);
    expect((await a.get('/api/messages?limit=100000')).status).toBe(400);
    expect((await a.get("/api/shared?type=photo' OR 1=1")).status).toBe(400);
    expect((await a.del('/api/messages/1%20OR%201=1')).status).toBe(400);
    expect((await a.post('/api/messages/read', { upToId: '1 OR 1=1' })).status).toBe(400);
  });
});

describe('SSRF protection for link previews', () => {
  it('classifies private and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses to fetch from loopback servers', async () => {
    let hit = false;
    const server = http.createServer((_req, res) => {
      hit = true;
      res.setHeader('content-type', 'text/html');
      res.end('<title>internal</title>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await fetchLinkMetadata(`http://127.0.0.1:${port}/`)).toBeNull();
      expect(await fetchLinkMetadata(`http://localhost:${port}/`)).toBeNull();
      expect(await fetchLinkMetadata('http://localhost/')).toBeNull();
      expect(hit).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('request limits', () => {
  it('rejects oversized JSON bodies and messages', async () => {
    expect((await a.post('/api/messages', { text: 'x'.repeat(10_001) })).status).toBe(400);
    expect((await a.post('/api/messages', { text: 'x'.repeat(100_000) })).status).toBe(413);
    expect((await a.post('/api/messages', { text: '   ' })).status).toBe(400);
  });

  it('returns no internal details for unknown routes', async () => {
    const res = await a.get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});

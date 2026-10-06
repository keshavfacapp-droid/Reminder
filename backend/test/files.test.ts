import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginBoth, setup, walk, type Client, type TestEnv } from './helpers.js';
import { docx, hasFfmpeg, jpeg, makeZip, mp4, PDF, png } from './fixtures.js';

let env: TestEnv;
let a: Client;
let b: Client;
beforeEach(async () => {
  env = await setup({ MAX_PHOTO_MB: '2', MAX_DOCUMENT_MB: '1' });
  [a, b] = await loginBoth(env);
});
afterEach(async () => {
  await env.close();
});

const storageFiles = () => walk(env.config.storageDir).map((f) => path.relative(env.config.storageDir, f));

describe('photo sharing', () => {
  it('stores the original, a compressed display copy and a thumbnail', async () => {
    const original = await jpeg(3000, 2000);
    const res = await a.upload('photo', original, 'holiday.jpg', 'beach');
    expect(res.status).toBe(201);
    const m = res.body.message;
    expect(m).toMatchObject({ type: 'photo', text: 'beach', file: { name: 'holiday.jpg', mime: 'image/jpeg', thumb: true, display: true } });

    const orig = await b.get(`/api/files/${m.id}/original`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(orig.status).toBe(200);
    expect(Buffer.compare(orig.body, original)).toBe(0);

    const display = await b.get(`/api/files/${m.id}/display`).buffer(true);
    expect(display.headers['content-type']).toBe('image/webp');
    const meta = await sharp(display.body as Buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048);

    const thumb = await b.get(`/api/files/${m.id}/thumb`).buffer(true);
    expect(thumb.status).toBe(200);
    expect(Math.max((await sharp(thumb.body as Buffer).metadata()).width!)).toBeLessThanOrEqual(480);
  });

  it('never uses the client file name on disk', async () => {
    const res = await a.upload('photo', await png(), '../../../etc/passwd.png');
    expect(res.status).toBe(201);
    expect(res.body.message.file.name).toBe('passwd.png');
    for (const f of storageFiles()) {
      expect(f).toMatch(/^(photos|thumbnails)\/[0-9a-f-]{36}(\.display)?\.(png|webp)$/);
    }
    expect(fs.existsSync(path.join(env.tmp, 'etc'))).toBe(false);
  });

  it('strips dangerous characters from display names', async () => {
    const res = await a.upload('photo', await png(), '<img src=x onerror=alert(1)>‮gnp.png');
    expect(res.status).toBe(201);
    expect(res.body.message.file.name).not.toMatch(/[<>‮]/);
  });
});

describe('upload validation', () => {
  it('rejects disallowed extensions', async () => {
    for (const [kind, name] of [
      ['document', 'evil.exe'],
      ['document', 'page.html'],
      ['document', 'image.svg'],
      ['photo', 'vector.svg'],
      ['document', 'noextension'],
    ]) {
      const res = await a.upload(kind, Buffer.from('MZ\x90\x00 just bytes'), name);
      expect(res.status, name).toBe(415);
    }
  });

  it('rejects content that does not match its extension (MIME spoofing)', async () => {
    expect((await a.upload('photo', Buffer.from('<html><script>alert(1)</script></html>'), 'x.png')).status).toBe(415);
    expect((await a.upload('document', await png(), 'fake.pdf')).status).toBe(415);
    expect((await a.upload('video', PDF, 'clip.mp4')).status).toBe(415);
    expect((await a.upload('document', Buffer.from([0, 1, 2, 3, 0, 255]), 'notes.txt')).status).toBe(415);
    expect((await a.upload('photo', PDF, 'photo.jpg')).status).toBe(415);
  });

  it('ignores the client-supplied Content-Type', async () => {
    const res = await a.agent
      .post('/api/messages/upload')
      .set('Origin', env.origin)
      .set('X-CSRF-Token', a.csrf)
      .field('kind', 'document')
      .attach('file', PDF, { filename: 'doc.pdf', contentType: 'text/html' });
    expect(res.status).toBe(201);
    expect(res.body.message.file.mime).toBe('application/pdf');
  });

  it('rejects oversized files', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(1.5 * 1024 * 1024)]);
    expect((await a.upload('document', big, 'big.pdf')).status).toBe(413);
    // Temporary upload files are cleaned up.
    expect(storageFiles().filter((f) => f.startsWith('tmp/'))).toEqual([]);
  });

  it('rejects an invalid upload kind and missing file', async () => {
    expect((await a.upload('script', PDF, 'a.pdf')).status).toBe(400);
    const res = await a.agent.post('/api/messages/upload').set('Origin', env.origin).set('X-CSRF-Token', a.csrf).field('kind', 'photo');
    expect(res.status).toBe(400);
  });

  it('accepts the supported document formats', async () => {
    const txt = await a.upload('document', Buffer.from('hello world – ünïcode\n'), 'notes.txt');
    expect(txt.status).toBe(201);
    expect(txt.body.message.file.mime).toBe('text/plain; charset=utf-8');
    const d = await a.upload('document', docx(), 'report.docx');
    expect(d.status).toBe(201);
    const z = await a.upload('document', makeZip({ 'a.txt': 'a' }), 'archive.zip');
    expect(z.status).toBe(201);
    expect((await a.upload('document', PDF, 'paper.pdf')).status).toBe(201);
  });
});

describe('file delivery', () => {
  it('requires authentication for every file', async () => {
    const { body } = await a.upload('photo', await png(), 'p.png');
    for (const v of ['original', 'display', 'thumb']) {
      expect((await request(env.baseUrl).get(`/api/files/${body.message.id}/${v}`)).status).toBe(401);
    }
  });

  it('has no public route to the storage directory', async () => {
    await a.upload('photo', await png(), 'p.png');
    const [stored] = storageFiles().filter((f) => f.startsWith('photos/'));
    for (const url of [`/storage/${stored}`, `/${stored}`, `/api/storage/${stored}`, `/api/files/${stored}`]) {
      const res = await a.get(url);
      expect(res.status, url).toBe(404);
    }
  });

  it('blocks path traversal attempts', async () => {
    for (const url of [
      '/api/files/..%2f..%2fetc%2fpasswd/original',
      '/api/files/1/..%2f..%2f..%2fetc%2fpasswd',
      '/api/files/%2e%2e/original',
      '/api/files/1%00/original',
      '/api/files/-1/original',
      '/api/files/1.5/original',
    ]) {
      const res = await a.get(url);
      expect([400, 404], url).toContain(res.status);
      expect(String(res.text)).not.toContain('root:');
    }
  });

  it('sends safe headers and forces download for office files', async () => {
    const { body } = await a.upload('document', docx(), 'report.docx');
    const res = await b.get(`/api/files/${body.message.id}/original`);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="?report.docx"?/);
    expect(res.headers['cache-control']).toContain('private');
  });

  it('opens PDFs inline unless download is requested', async () => {
    const { body } = await a.upload('document', PDF, 'paper.pdf');
    expect((await b.get(`/api/files/${body.message.id}/original`)).headers['content-disposition']).toMatch(/^inline/);
    expect((await b.get(`/api/files/${body.message.id}/original?download=1`)).headers['content-disposition']).toMatch(/^attachment/);
  });

  it('deleting a message removes its files', async () => {
    const { body } = await a.upload('photo', await png(), 'p.png');
    expect(storageFiles().length).toBe(3);
    await a.del(`/api/messages/${body.message.id}`).expect(200);
    expect(storageFiles()).toEqual([]);
    expect((await b.get(`/api/files/${body.message.id}/original`)).status).toBe(404);
  });

  it('lists shared media by type', async () => {
    await a.upload('photo', await png(), 'p.png');
    await a.upload('document', PDF, 'd.pdf');
    await b.post('/api/messages', { text: 'see https://example.com/page' });
    expect((await b.get('/api/shared?type=photo')).body.messages).toHaveLength(1);
    expect((await b.get('/api/shared?type=document')).body.messages).toHaveLength(1);
    expect((await b.get('/api/shared?type=link')).body.messages).toHaveLength(1);
    expect((await b.get('/api/shared?type=video')).body.messages).toHaveLength(0);
    expect((await b.get('/api/shared?type=users')).status).toBe(400);
  });
});

describe.runIf(hasFfmpeg())('video sharing', () => {
  it('stores videos, generates a thumbnail and supports range requests', async () => {
    const video = mp4(env.tmp);
    const res = await a.upload('video', video, 'clip.mp4');
    expect(res.status).toBe(201);
    expect(res.body.message.file).toMatchObject({ mime: 'video/mp4', thumb: true });
    const id = res.body.message.id;
    const range = await b.get(`/api/files/${id}/original`).set('Range', 'bytes=0-99');
    expect(range.status).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 0-99/${video.length}`);
    expect((await b.get(`/api/files/${id}/thumb`)).headers['content-type']).toBe('image/webp');
  });
});

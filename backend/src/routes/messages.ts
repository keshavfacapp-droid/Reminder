import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { HttpError } from '../middleware/errors.js';
import { extractFirstUrl, fetchLinkMetadata, sanitizeUrl } from '../services/links.js';
import { MAX_TEXT_LENGTH, toDto, type MessageRow } from '../services/messages.js';
import type { FileKind } from '../services/storage.js';

const TextBody = z.object({ text: z.string().min(1).max(MAX_TEXT_LENGTH) });
const LinkBody = z.object({ url: z.string().min(1).max(2048), text: z.string().max(MAX_TEXT_LENGTH).optional() });
const ReadBody = z.object({ upToId: z.number().int().positive() });
const PageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const SharedQuery = PageQuery.extend({ type: z.enum(['photo', 'video', 'document', 'link']) });
const KindBody = z.object({ kind: z.enum(['photo', 'video', 'document']), caption: z.string().max(MAX_TEXT_LENGTH).optional() });
const IdParam = z.coerce.number().int().positive();

export function messageRoutes(ctx: AppContext): Router {
  const router = Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: ctx.storage.tmpDir,
      // Never use the client's file name on disk.
      filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
    }),
    limits: { fileSize: ctx.storage.maxUploadBytes, files: 1, fields: 5, fieldSize: MAX_TEXT_LENGTH * 4, parts: 8 },
  });

  const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
  });

  /** Broadcasts a new/updated message and pings the other person. */
  const publish = async (row: MessageRow, kind: 'message:new' | 'message:updated') => {
    ctx.hub.broadcast((viewerId) => ({ type: kind, message: toDto(row, viewerId) }));
    if (kind === 'message:new') {
      const recipient = await ctx.users.otherUserId(Number(row.sender_id));
      if (recipient !== undefined && !ctx.hub.isActivelyViewing(recipient)) {
        void ctx.push.notify(recipient).catch(() => undefined);
      }
    }
  };

  const enrichLink = (row: MessageRow) => {
    if (!ctx.config.linkPreviews || !row.link_url) return;
    void fetchLinkMetadata(row.link_url)
      .then(async (meta) => {
        if (!meta || (!meta.title && !meta.site)) return;
        const updated = await ctx.messages.setLinkMetadata(Number(row.id), meta.title, meta.site);
        if (updated) ctx.hub.broadcast((viewerId) => ({ type: 'message:updated', message: toDto(updated, viewerId) }));
      })
      .catch(() => undefined);
  };

  router.get('/messages', async (req, res) => {
    const q = PageQuery.parse(req.query);
    const rows = await ctx.messages.list(q);
    res.set('Cache-Control', 'no-store');
    res.json({ messages: rows.map((r) => toDto(r, req.auth!.user.id)) });
  });

  router.get('/messages/unread-count', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ count: await ctx.messages.unreadCount(req.auth!.user.id) });
  });

  router.post('/messages', async (req, res) => {
    const { text } = TextBody.parse(req.body);
    const row = await ctx.messages.createText(req.auth!.user.id, text, extractFirstUrl(text));
    await publish(row, 'message:new');
    enrichLink(row);
    res.status(201).json({ message: toDto(row, req.auth!.user.id) });
  });

  router.post('/messages/link', async (req, res) => {
    const body = LinkBody.parse(req.body);
    const url = sanitizeUrl(body.url);
    if (!url) throw new HttpError(400, 'invalid_url', 'Only http(s) links are allowed.');
    const text = body.text?.trim() ? `${body.text.trim()}\n${url}` : url;
    const row = await ctx.messages.createText(req.auth!.user.id, text, url);
    await publish(row, 'message:new');
    enrichLink(row);
    res.status(201).json({ message: toDto(row, req.auth!.user.id) });
  });

  router.post('/messages/upload', uploadLimiter, upload.single('file'), async (req, res) => {
    const file = req.file;
    try {
      if (!file) throw new HttpError(400, 'no_file');
      const body = KindBody.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'invalid_request');
      const kind: FileKind = body.data.kind;
      const stored = await ctx.storage.ingest(kind, file.path, file.originalname, file.size);
      const row = await ctx.messages.createFile(req.auth!.user.id, kind, stored, body.data.caption ?? null);
      await publish(row, 'message:new');
      res.status(201).json({ message: toDto(row, req.auth!.user.id) });
    } finally {
      if (file) await ctx.storage.remove(`tmp/${file.filename}`);
    }
  });

  router.post('/messages/read', async (req, res) => {
    const { upToId } = ReadBody.parse(req.body);
    const result = await ctx.markRead(req.auth!.user.id, upToId);
    res.json({ ok: true, count: result.ids.length });
  });

  router.delete('/messages/:id', async (req, res) => {
    const id = IdParam.parse(req.params.id);
    await ctx.messages.delete(req.auth!.user.id, id);
    ctx.hub.broadcast(() => ({ type: 'message:deleted', id }));
    res.json({ ok: true });
  });

  router.get('/shared', async (req, res) => {
    const q = SharedQuery.parse(req.query);
    const rows = await ctx.messages.shared(q.type, q);
    res.set('Cache-Control', 'no-store');
    res.json({ messages: rows.map((r) => toDto(r, req.auth!.user.id)) });
  });

  return router;
}

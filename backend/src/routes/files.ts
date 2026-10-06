import fs from 'node:fs';
import { Router } from 'express';
import { create as contentDisposition } from 'content-disposition';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { HttpError } from '../middleware/errors.js';

const Params = z.object({
  id: z.coerce.number().int().positive(),
  variant: z.enum(['original', 'display', 'thumb']),
});

// Types that browsers can display safely inline. Everything else is always
// sent as a download.
const INLINE_TYPES = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm)|application\/pdf|text\/plain)/;

/**
 * Private file delivery. There is no static directory: every file goes
 * through authentication (requireAuth on the router), then a database lookup
 * that maps a message ID to a server-generated path. Request input is never
 * used to build a filesystem path.
 */
export function fileRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/files/:id/:variant', async (req, res) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) throw new HttpError(404, 'not_found');
    const { id, variant } = parsed.data;

    const row = await ctx.messages.get(id);
    if (!row || !row.file_path) throw new HttpError(404, 'not_found');

    let rel = row.file_path;
    let mime = row.mime_type ?? 'application/octet-stream';
    if (variant === 'thumb') {
      if (!row.thumb_path) throw new HttpError(404, 'not_found');
      rel = row.thumb_path;
      mime = 'image/webp';
    } else if (variant === 'display') {
      if (row.display_path) {
        rel = row.display_path;
        mime = 'image/webp';
      }
    }

    const abs = ctx.storage.resolve(rel);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'not_found');

    const download = req.query.download === '1' || !INLINE_TYPES.test(mime);
    res.set({
      'Content-Type': mime,
      'Content-Disposition': contentDisposition(row.file_name ?? 'file', { type: download ? 'attachment' : 'inline' }),
      'X-Content-Type-Options': 'nosniff',
      // Files can never execute script in our origin, even if a viewer tries.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      // Revalidate every time; keeps private media out of long-lived caches.
      'Cache-Control': 'private, no-cache',
    });
    res.sendFile(abs, { dotfiles: 'deny', headers: { 'Content-Type': mime } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not_found' });
    });
  });

  return router;
}

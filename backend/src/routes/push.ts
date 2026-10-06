import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { HttpError } from '../middleware/errors.js';

const b64url = z.string().min(8).max(255).regex(/^[A-Za-z0-9_-]+=*$/);
const SubscribeBody = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: b64url, auth: b64url }),
});
const UnsubscribeBody = z.object({ endpoint: z.string().url().max(2048) });

export function pushRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/push/config', (_req, res) => {
    res.json({ enabled: ctx.push.enabled, publicKey: ctx.push.publicKey ?? null });
  });

  router.post('/push/subscribe', async (req, res) => {
    if (!ctx.push.enabled) throw new HttpError(503, 'push_disabled');
    const sub = SubscribeBody.parse(req.body);
    if (!sub.endpoint.startsWith('https://')) throw new HttpError(400, 'invalid_endpoint');
    // The subscription is always bound to the session's user, never a client-supplied ID.
    await ctx.push.subscribe(req.auth!.user.id, sub);
    res.status(201).json({ ok: true });
  });

  router.post('/push/unsubscribe', async (req, res) => {
    const { endpoint } = UnsubscribeBody.parse(req.body);
    await ctx.push.unsubscribe(req.auth!.user.id, endpoint);
    res.json({ ok: true });
  });

  return router;
}

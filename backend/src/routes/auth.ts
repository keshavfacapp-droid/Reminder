import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { requireCsrf, sessionCookieName, sessionCookieOptions } from '../middleware/auth.js';
import { MAX_PASSWORD_LENGTH } from '../services/passwords.js';

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const cookieName = sessionCookieName(ctx.config);

  // Per-IP limit on login attempts.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'rate_limited' },
  });

  // Per-username lockout (protects against distributed guessing).
  const failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

  router.post('/login', loginLimiter, async (req, res) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const { username, password } = parsed.data;
    const key = username.toLowerCase();
    const now = Date.now();
    const record = failures.get(key);
    if (record && record.lockedUntil > now) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    const user = await ctx.users.findByUsername(username);
    const ok = await ctx.hasher.verify(user?.password_hash, password);
    const authorized = user ? (await ctx.users.authorizedIds()).includes(Number(user.id)) : false;
    if (!user || !ok || !authorized) {
      const fresh = !record || now - record.first > LOCKOUT_MS;
      const count = fresh ? 1 : record.count + 1;
      if (failures.size > 10_000) failures.clear();
      failures.set(key, {
        count,
        first: fresh ? now : record.first,
        lockedUntil: count >= LOCKOUT_THRESHOLD ? now + LOCKOUT_MS : 0,
      });
      // Same response for unknown user and wrong password.
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    failures.delete(key);

    // Always issue a brand-new session on login (prevents session fixation).
    const old = req.cookies?.[cookieName];
    if (old) {
      const prev = await ctx.sessions.resolve(old, await ctx.users.authorizedIds());
      if (prev) await ctx.sessions.destroy(prev.id);
    }
    const session = await ctx.sessions.create(Number(user.id));
    await ctx.users.touchLastSeen(Number(user.id));
    // The cookie lives until the absolute expiry; idle expiry is enforced server-side.
    res.cookie(cookieName, session.token, sessionCookieOptions(ctx.config, session.absoluteExpiresAt));
    res.json({ ok: true, csrfToken: session.csrfToken });
  });

  router.get('/session', ctx.requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      authenticated: true,
      user: { id: req.auth!.user.id },
      csrfToken: req.auth!.csrfToken,
    });
  });

  router.post('/logout', ctx.requireAuth, requireCsrf, async (req, res) => {
    await ctx.sessions.destroy(req.auth!.id);
    ctx.hub.disconnectSession(req.auth!.id);
    res.clearCookie(cookieName, sessionCookieOptions(ctx.config));
    res.json({ ok: true });
  });

  return router;
}

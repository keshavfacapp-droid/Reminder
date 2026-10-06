import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from '../config.js';
import { safeEqual, type SessionInfo, type SessionService } from '../services/sessions.js';
import type { UserService } from '../services/users.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: SessionInfo;
  }
}

export function sessionCookieName(config: Config): string {
  // The __Host- prefix forces Secure, Path=/ and no Domain attribute.
  return config.cookieSecure ? '__Host-ps_session' : 'ps_session';
}

export function sessionCookieOptions(config: Config, expiresAt?: number) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict' as const,
    path: '/',
    ...(expiresAt ? { expires: new Date(expiresAt) } : {}),
  };
}

/**
 * Authentication + authorisation gate used on every private route:
 *   1. Is there a valid, unexpired session?
 *   2. Does it belong to one of the two authorised users?
 * The user identity always comes from the server-side session, never from
 * anything the client sends.
 */
export function requireAuth(config: Config, sessions: SessionService, users: UserService): RequestHandler {
  const cookieName = sessionCookieName(config);
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[cookieName] as string | undefined;
    const info = await sessions.resolve(token, await users.authorizedIds());
    if (!info) {
      if (token) res.clearCookie(cookieName, sessionCookieOptions(config));
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.auth = info;
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Synchroniser-token CSRF check for every state-changing authenticated request. */
export const requireCsrf: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const header = req.get('x-csrf-token');
  if (!req.auth || !header || !safeEqual(header, req.auth.csrfToken)) {
    res.status(403).json({ error: 'csrf' });
    return;
  }
  next();
};

/** Returns the origin the browser should be using for this request. */
export function expectedOrigin(config: Config, req: Request): string {
  if (config.publicOrigin) return config.publicOrigin;
  return `${req.protocol}://${req.get('host')}`;
}

export function isAllowedOrigin(config: Config, origin: string | undefined, req: Request): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === expectedOrigin(config, req);
  } catch {
    return false;
  }
}

/**
 * Defence in depth against CSRF: reject state-changing requests whose Origin
 * (or Referer, if Origin is absent) is a different site.
 */
export function originCheck(config: Config): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    const referer = req.get('referer');
    if (origin !== undefined) {
      if (origin === 'null' || !isAllowedOrigin(config, origin, req)) {
        res.status(403).json({ error: 'origin' });
        return;
      }
    } else if (referer !== undefined && !isAllowedOrigin(config, referer, req)) {
      res.status(403).json({ error: 'origin' });
      return;
    }
    next();
  };
}

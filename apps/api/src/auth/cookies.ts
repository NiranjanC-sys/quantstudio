/**
 * Session and CSRF cookie handling (system-design §8): `HttpOnly; Secure;
 * SameSite=Lax`, sliding 14 days.
 */
import type { FastifyReply } from 'fastify';
import type { Env } from '../env.js';
import { issueCsrfToken } from '../middleware/security.js';
import { sha256Hex } from '../lib/crypto.js';

export function setSessionCookie(env: Env, reply: FastifyReply, token: string): void {
  const base = {
    path: '/',
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: 'lax' as const,
    maxAge: env.SESSION_TTL_SECONDS,
    ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
  };

  void reply.setCookie(env.SESSION_COOKIE_NAME, token, { ...base, httpOnly: true });

  // The CSRF cookie is deliberately readable by the SPA: it is the value the SPA
  // must echo in `x-csrf-token`. It is bound to this session by an HMAC, so it
  // is useless on any other session.
  void reply.setCookie(env.CSRF_COOKIE_NAME, issueCsrfToken(env.CSRF_SECRET, sha256Hex(token)), {
    ...base,
    httpOnly: false,
  });
}

export function clearSessionCookie(env: Env, reply: FastifyReply): void {
  const base = {
    path: '/',
    ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
  };
  void reply.clearCookie(env.SESSION_COOKIE_NAME, base);
  void reply.clearCookie(env.CSRF_COOKIE_NAME, base);
}

/**
 * Transport-level hardening: strict CORS, helmet-equivalent headers, and CSRF.
 *
 * CSRF uses a double-submit token *bound to the session*: the cookie carries
 * `nonce.hmac(secret, nonce|sessionKey)`, so an attacker who can set a cookie on
 * the victim's browser still cannot forge a matching pair for the victim's
 * session. Session cookies are `SameSite=Lax` (§8), which stops the simple
 * cross-site form POST; this covers the rest.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../errors.js';
import { hmacHex, safeEqual, sha256Hex } from '../lib/crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Endpoints authenticated by something other than the session cookie. */
const CSRF_EXEMPT = [
  /^\/billing\/webhook$/,
  /^\/scim\/v2\//,
  /^\/auth\/saml\/[^/]+\/acs$/,
  /^\/auth\/oauth\/[^/]+\/callback$/,
];

export function issueCsrfToken(secret: string, sessionKey: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${hmacHex(secret, `${nonce}|${sessionKey}`)}`;
}

export function csrfTokenValid(secret: string, sessionKey: string, token: string): boolean {
  const [nonce, mac] = token.split('.');
  if (!nonce || !mac) return false;
  return safeEqual(mac, hmacHex(secret, `${nonce}|${sessionKey}`));
}

export const securityPlugin = fp(async (app: FastifyInstance) => {
  const { env } = app.services;

  await app.register(cookie, {
    parseOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.SESSION_COOKIE_SECURE,
      path: '/',
      ...(env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {}),
    },
  });

  const allowed = new Set(env.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    // An explicit allowlist, and credentials, which together forbid `*`.
    origin(origin, callback) {
      if (!origin) {
        // Same-origin and non-browser callers send no Origin header.
        callback(null, true);
        return;
      }
      callback(null, allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-csrf-token',
      'x-request-id',
      'idempotency-key',
      'traceparent',
    ],
    exposedHeaders: [
      'x-request-id',
      'x-trace-id',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'retry-after',
    ],
    maxAge: 600,
  });

  await app.register(helmet, {
    // The API serves JSON, never HTML, so the CSP can be maximally restrictive.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.SESSION_COOKIE_SECURE
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
    xFrameOptions: { action: 'deny' },
    noSniff: true,
    xDnsPrefetchControl: { allow: false },
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    return payload;
  });

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (CSRF_EXEMPT.some((re) => re.test(request.url.split('?')[0] ?? ''))) return;

    const sessionCookie = request.cookies[env.SESSION_COOKIE_NAME];
    // Bearer-authenticated calls (API keys, service tokens) are not
    // cookie-driven and therefore not forgeable cross-site.
    if (!sessionCookie) return;

    const header = request.headers['x-csrf-token'];
    const cookieToken = request.cookies[env.CSRF_COOKIE_NAME];

    if (typeof header !== 'string' || !cookieToken || header !== cookieToken) {
      throw new ApiError('forbidden', 'CSRF token missing or does not match.');
    }

    if (!csrfTokenValid(env.CSRF_SECRET, sha256Hex(sessionCookie), header)) {
      throw new ApiError('forbidden', 'CSRF token is not bound to this session.');
    }
  });
});

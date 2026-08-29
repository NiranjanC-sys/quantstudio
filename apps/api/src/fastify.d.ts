/**
 * Fastify decorations. Declared once, so every route module sees the same
 * typed request and instance without importing a bespoke request type.
 */
import type { AuthContext } from './auth/types.js';
import type { Entitlements } from './entitlements/index.js';
import type { Services } from './services.js';

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
    /** Throws 401 unless a valid session (or service token) is present. */
    requireAuth: (request: FastifyRequest) => AuthContext;
  }

  interface FastifyRequest {
    /** W3C trace id for this request; echoed in problem+json and in logs. */
    traceId: string;
    /** Resolved session, or `null` for anonymous traffic. */
    auth: AuthContext | null;
    /** Entitlements of `auth.userId`, refreshed if the cached stamp went stale. */
    entitlements: Entitlements | null;
    /** §5: true when this request must read from the primary. */
    readFromPrimary: boolean;
    /** Pseudonymised client address, safe to log (§11). */
    clientIpHash: string | null;
    /** Set by the idempotency middleware so the hook can store the response. */
    idempotency: { key: string; redisKey: string; replayed: boolean } | null;
  }
}

export {};

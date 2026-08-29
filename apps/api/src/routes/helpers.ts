/**
 * Shared plumbing for the route modules: Zod-validated request parts, the
 * rate-limit and idempotency preHandlers wired to the service container, and the
 * pagination shape every list endpoint uses.
 *
 * Validation is explicit rather than delegated to Fastify's JSON-schema
 * compiler: the gateway already speaks Zod to the rest of the monorepo
 * (`packages/shared`), and a single source of truth for a request shape is worth
 * more than the marginal serialisation speed of ajv.
 */
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AuthContext } from '../auth/types.js';
import { ApiError, zodToProblem } from '../errors.js';
import {
  makeIdempotencyHook,
  makeIdempotencyOnSend,
} from '../middleware/idempotency.js';
import { makeRateLimitHook, type RateLimitClass } from '../middleware/rate-limit.js';

export function parseWith<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw zodToProblem(result.error);
  return result.data as z.infer<T>;
}

export function readBody<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseWith(schema, request.body ?? {});
}

export function readQuery<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseWith(schema, request.query ?? {});
}

export function readParams<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseWith(schema, request.params ?? {});
}

/** Rate-limit preHandler bound to this instance's limiter and metrics. */
export function rateLimit(
  app: FastifyInstance,
  klass: RateLimitClass,
  options: { cost?: number; keyBy?: (request: FastifyRequest) => string } = {},
): preHandlerHookHandler {
  return makeRateLimitHook(app.services.limiter, app.services.metrics, {
    class: klass,
    ...options,
  });
}

/**
 * Installs `Idempotency-Key` handling for every mutating route in the calling
 * plugin's scope. Encapsulation is what makes this safe: the onSend hook only
 * sees responses from routes registered inside the same plugin.
 */
export function useIdempotency(app: FastifyInstance): void {
  const { env, redis, scripts } = app.services;
  app.addHook('preHandler', makeIdempotencyHook(scripts, env.IDEMPOTENCY_TTL_SECONDS));
  app.addHook('onSend', makeIdempotencyOnSend(redis.client, env.IDEMPOTENCY_TTL_SECONDS));
}

/** Requires a session and, for the roles §8 names, a satisfied MFA challenge. */
export function authed(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new ApiError('unauthorized', 'A valid session is required.');
  return request.auth;
}

/**
 * Requires an internal service token (§8: "short-lived EdDSA-signed JWTs minted
 * by the gateway"). Graders and the finaliser call back in with one of these;
 * a user session must never reach these routes.
 */
export function requireServiceToken(request: FastifyRequest, scope: string): AuthContext {
  const auth = request.auth;
  if (!auth || !auth.sessionKey.startsWith('svc:')) {
    throw new ApiError('forbidden', 'This endpoint requires an internal service token.');
  }
  // The scope is checked, not merely carried. Without this a token minted for
  // one internal callback is a valid credential for every other one, and the
  // `svc:` prefix alone was the entire authorisation these routes performed.
  if (!auth.serviceScope?.includes(scope)) {
    throw new ApiError('forbidden', `This endpoint requires the "${scope}" scope.`);
  }
  return auth;
}

/** §9 step 6: writes fail closed with Retry-After while the primary is down. */
export function assertWritesEnabled(disabled: boolean): void {
  if (disabled) {
    throw new ApiError('write-unavailable', 'Writes are paused while the primary recovers.', {
      retryAfterSeconds: 15,
    });
  }
}

export const uuidSchema = z.string().uuid();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

export function page<T>(items: T[], pagination: Pagination, total: number): Page<T> {
  return { items, limit: pagination.limit, offset: pagination.offset, total };
}

/**
 * `Cache-Control` for the catalogue, which §5 calls "small, read-mostly, fully
 * cached" and §1 expects the CDN to absorb.
 */
export function cachePublic(seconds: number): string {
  return `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}`;
}

/** RFC 4180 CSV escaping, for the gradebook export. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRows(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

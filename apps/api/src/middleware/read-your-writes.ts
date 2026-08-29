/**
 * Read-your-own-writes routing (system-design §5):
 *
 *   "Reads to replicas, except reads inside a write transaction and reads within
 *    500 ms of a user's own write (tracked by a per-user `write_lsn` in Redis, so
 *    the user always sees their own action)."
 *
 * The marker stores the deadline rather than a duration, so the check is one GET
 * and the window closes on its own.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import { keys } from '../redis/scripts.js';
import type { ScriptRunner } from '../redis/scripts.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface WriteMarker {
  /** Called after a successful write; opens the window for this user. */
  mark(userId: string): Promise<void>;
  isLive(userId: string): Promise<boolean>;
}

export function createWriteMarker(
  redis: Redis,
  scripts: ScriptRunner,
  windowMs: number,
): WriteMarker {
  const ttlSeconds = Math.max(1, Math.ceil((windowMs * 2) / 1000));

  return {
    async mark(userId) {
      await redis.set(keys.writeMarker(userId), String(Date.now() + windowMs), 'EX', ttlSeconds);
    },
    async isLive(userId) {
      return scripts.writeMarkerLive(keys.writeMarker(userId), Date.now());
    },
  };
}

export const readYourWritesPlugin = fp(async (app: FastifyInstance) => {
  const { env, redis, scripts } = app.services;
  const marker = createWriteMarker(redis.client, scripts, env.READ_YOUR_WRITES_WINDOW_MS);

  app.decorateRequest('readFromPrimary', false);
  app.decorate('writeMarker', marker);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    // A mutation reads and writes on the primary by definition.
    if (UNSAFE_METHODS.has(request.method)) {
      request.readFromPrimary = true;
      return;
    }
    if (!request.auth) return;
    request.readFromPrimary = await marker.isLive(request.auth.userId);
  });

  // Any successful mutation opens the window, so the very next read from this
  // user is served by the primary.
  app.addHook('onResponse', async (request, reply) => {
    if (!request.auth) return;
    if (!UNSAFE_METHODS.has(request.method)) return;
    // Successful mutations only: a rejected write changed nothing, and marking
    // it would push this user's reads onto the primary for no reason.
    if (reply.statusCode >= 400) return;
    await marker.mark(request.auth.userId);
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    writeMarker: WriteMarker;
  }
}

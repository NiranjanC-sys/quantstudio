/**
 * `Idempotency-Key` handling (system-design §9):
 *
 *   "Every mutating endpoint accepts Idempotency-Key; the gateway stores
 *    (key, user, response) in Redis for 24 h."
 *
 * The record is claimed atomically before the handler runs, so two concurrent
 * retries cannot both execute: the loser either replays the stored response or,
 * if the winner is still working, gets a 409 telling it to retry shortly. Reusing
 * a key with a *different* request body is a client bug and is rejected rather
 * than silently answered with the wrong response.
 */
import type { FastifyReply, FastifyRequest, onSendHookHandler, preHandlerHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import { ApiError, PROBLEM_CONTENT_TYPE } from '../errors.js';
import { sha256Hex } from '../lib/crypto.js';
import { keys } from '../redis/scripts.js';
import type { ScriptRunner } from '../redis/scripts.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

interface StoredResponse {
  status: number;
  body: unknown;
  contentType: string;
}

/** Bodies over this size are not cached; the key still guards re-execution. */
const MAX_STORED_BODY_BYTES = 256 * 1024;

export interface IdempotencyOptions {
  /** When true a mutating request without the header is rejected. */
  required?: boolean;
}

export function makeIdempotencyHook(
  scripts: ScriptRunner,
  ttlSeconds: number,
  options: IdempotencyOptions = {},
): preHandlerHookHandler {
  return async function idempotencyHook(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers[IDEMPOTENCY_HEADER];
    const key = typeof header === 'string' ? header.trim() : '';

    if (!key) {
      if (options.required) {
        throw new ApiError('validation-failed', 'This endpoint requires an Idempotency-Key header.');
      }
      request.idempotency = null;
      return;
    }

    if (key.length < 8 || key.length > 255) {
      throw new ApiError('validation-failed', 'Idempotency-Key must be 8-255 characters.');
    }

    // Anonymous callers are scoped by IP hash; §9 says (key, user, response).
    const subject = request.auth?.userId ?? `anon:${request.clientIpHash ?? 'unknown'}`;
    const redisKey = keys.idempotency(subject, key);

    // The fingerprint binds the key to this exact request, so a client that
    // reuses a key for a different payload is told, rather than being handed
    // someone else's answer.
    const fingerprint = sha256Hex(
      `${request.method}|${request.routeOptions?.url ?? request.url}|${JSON.stringify(request.body ?? null)}`,
    );

    const [state, payload] = await scripts.idempotencyBegin(redisKey, fingerprint, ttlSeconds);

    if (state === 'mismatch') {
      throw new ApiError(
        'idempotency-key-reuse',
        'This Idempotency-Key was already used with a different request body.',
      );
    }

    if (state === 'in_flight') {
      throw new ApiError(
        'conflict',
        'A request with this Idempotency-Key is still being processed.',
        { retryAfterSeconds: 1 },
      );
    }

    if (state === 'replay' && payload) {
      const stored = JSON.parse(payload) as StoredResponse;
      request.idempotency = { key, redisKey, replayed: true };
      void reply.header('idempotency-replayed', 'true');
      await reply.status(stored.status).type(stored.contentType).send(stored.body);
      return reply;
    }

    request.idempotency = { key, redisKey, replayed: false };
    return;
  };
}

/**
 * Stores the response against the key. Errors are stored too — a 4xx is a stable
 * answer and replaying it is correct — but 5xx and 429 are not, because those
 * are exactly the cases the client is supposed to retry.
 */
export function makeIdempotencyOnSend(redis: Redis, ttlSeconds: number): onSendHookHandler {
  return async function idempotencyOnSend(request, reply, payload) {
    const record = request.idempotency;
    if (!record || record.replayed) return payload;

    const status = reply.statusCode;
    if (status >= 500 || status === 429) {
      // Release the claim so the retry can actually run.
      await redis.del(record.redisKey);
      return payload;
    }

    const contentType = reply.getHeader('content-type');
    const body = typeof payload === 'string' ? payload : null;

    if (body !== null && Buffer.byteLength(body) <= MAX_STORED_BODY_BYTES) {
      const stored: StoredResponse = {
        status,
        body: JSON.parse(body) as unknown,
        contentType:
          typeof contentType === 'string'
            ? contentType
            : status >= 400
              ? PROBLEM_CONTENT_TYPE
              : 'application/json; charset=utf-8',
      };
      await redis
        .multi()
        .hset(record.redisKey, 'state', 'done', 'body', JSON.stringify(stored))
        .expire(record.redisKey, ttlSeconds)
        .exec();
    } else {
      await redis.del(record.redisKey);
    }

    return payload;
  };
}

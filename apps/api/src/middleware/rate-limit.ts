/**
 * Token-bucket rate limiting (system-design §9), in Redis, in Lua, per user and
 * per IP, with a per-cell circuit breaker.
 *
 *   | Endpoint class      | Limit                                          |
 *   |---------------------|------------------------------------------------|
 *   | Read                | 120 / 10 s                                     |
 *   | Server simulation   | 30 / min (Free), 240 / min (Pro)               |
 *   | Lab submission      | 6 / min                                        |
 *   | Contest submission  | 10 / min, plus 20 s per-problem cooldown       |
 *   | AI tutor            | plan-based, plus a 50k token/day hard ceiling  |
 *   | Auth                | 10 / 10 min / IP, exponential backoff on failure|
 *
 * The buckets themselves are in `src/redis/scripts.ts`; this module is the
 * policy and the Fastify wiring.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Redis } from 'ioredis';
import { ApiError } from '../errors.js';
import type { Entitlements } from '../entitlements/index.js';
import { keys } from '../redis/scripts.js';
import type { ScriptRunner } from '../redis/scripts.js';
import type { Metrics } from '../telemetry.js';

export type RateLimitClass =
  | 'read'
  | 'write'
  | 'simulation'
  | 'lab_submission'
  | 'contest_submission'
  | 'tutor'
  | 'auth';

export interface BucketPolicy {
  /** Burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Bucket key TTL; a bucket idle this long is simply forgotten. */
  ttlSeconds: number;
}

/** The §9 table, expressed as buckets. */
export const POLICIES: Record<Exclude<RateLimitClass, 'simulation' | 'tutor'>, BucketPolicy> = {
  // 120 requests per 10 s.
  read: { capacity: 120, refillPerSecond: 12, ttlSeconds: 120 },
  // Generic mutations are not called out in §9; they get the lab budget.
  write: { capacity: 30, refillPerSecond: 0.5, ttlSeconds: 300 },
  // 6 per minute.
  lab_submission: { capacity: 6, refillPerSecond: 0.1, ttlSeconds: 600 },
  // 10 per minute.
  contest_submission: { capacity: 10, refillPerSecond: 10 / 60, ttlSeconds: 600 },
  // 10 per 10 minutes, per IP.
  auth: { capacity: 10, refillPerSecond: 10 / 600, ttlSeconds: 3_600 },
};

/** §9: server simulation is 30/min on Free, 240/min on Pro and above. */
export function simulationPolicy(entitlements: Entitlements | null): BucketPolicy {
  const perMinute = entitlements?.simulationsPerMinute ?? 30;
  return { capacity: perMinute, refillPerSecond: perMinute / 60, ttlSeconds: 300 };
}

/** §7: AI tutor messages per day, by plan. */
export function tutorPolicy(entitlements: Entitlements | null): BucketPolicy {
  const perDay = entitlements?.tutorMessagesPerDay ?? 15;
  return { capacity: perDay, refillPerSecond: perDay / 86_400, ttlSeconds: 172_800 };
}

/** §6: a contest submission has a 20 s per-problem cooldown on top of the bucket. */
export const CONTEST_PROBLEM_COOLDOWN_SECONDS = 20;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetSeconds: number;
}

export interface RateLimiter {
  consume(input: {
    bucket: string;
    policy: BucketPolicy;
    cost?: number;
  }): Promise<RateLimitDecision>;
  /** §9: exponential backoff after failed authentication, keyed by IP. */
  recordAuthFailure(ipHash: string): Promise<number>;
  clearAuthFailures(ipHash: string): Promise<void>;
  authBackoffRemainingSeconds(ipHash: string): Promise<number>;
  /** Per-problem cooldown, returns seconds remaining (0 when clear). */
  contestCooldownRemaining(contestId: string, userId: string, problemId: string): Promise<number>;
  markContestCooldown(contestId: string, userId: string, problemId: string): Promise<void>;
}

export function createRateLimiter(
  redis: Redis,
  scripts: ScriptRunner,
  metrics: Metrics,
  enabled: boolean,
): RateLimiter {
  return {
    async consume({ bucket, policy, cost = 1 }) {
      if (!enabled) {
        return {
          allowed: true,
          limit: policy.capacity,
          remaining: policy.capacity,
          retryAfterSeconds: 0,
          resetSeconds: 0,
        };
      }

      const [allowed, remaining, retryAfterMs, resetMs] = await scripts.tokenBucket(
        keys.rateLimit(bucket),
        policy.capacity,
        policy.refillPerSecond,
        Date.now(),
        cost,
        policy.ttlSeconds,
      );

      return {
        allowed: allowed === 1,
        limit: policy.capacity,
        remaining,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        resetSeconds: Math.ceil(resetMs / 1000),
      };
    },

    /**
     * Failures are counted in a key whose TTL is the backoff itself, so the
     * penalty decays without a sweeper: 2 s, 4 s, 8 s … capped at 15 minutes.
     */
    async recordAuthFailure(ipHash) {
      const key = keys.rateLimit(`authfail:${ipHash}`);
      const failures = await redis.incr(key);
      const backoff = Math.min(900, 2 ** Math.min(failures, 10));
      await redis.expire(key, backoff);
      metrics.rateLimitDecisions.inc({ class: 'auth', decision: 'failure' });
      return backoff;
    },

    async clearAuthFailures(ipHash) {
      await redis.del(keys.rateLimit(`authfail:${ipHash}`));
    },

    async authBackoffRemainingSeconds(ipHash) {
      const key = keys.rateLimit(`authfail:${ipHash}`);
      const failures = Number((await redis.get(key)) ?? '0');
      // The first two failures are free; typos are not an attack.
      if (failures < 3) return 0;
      const ttl = await redis.ttl(key);
      return ttl > 0 ? ttl : 0;
    },

    async contestCooldownRemaining(contestId, userId, problemId) {
      const ttl = await redis.ttl(keys.problemCooldown(contestId, userId, problemId));
      return ttl > 0 ? ttl : 0;
    },

    async markContestCooldown(contestId, userId, problemId) {
      await redis.set(
        keys.problemCooldown(contestId, userId, problemId),
        '1',
        'EX',
        CONTEST_PROBLEM_COOLDOWN_SECONDS,
      );
    },
  };
}

function applyHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
  void reply.header('ratelimit-limit', String(decision.limit));
  void reply.header('ratelimit-remaining', String(Math.max(0, decision.remaining)));
  void reply.header('ratelimit-reset', String(decision.resetSeconds));
}

export interface RateLimitOptions {
  class: RateLimitClass;
  /** Overrides the identity the bucket is keyed on. Defaults to user, else IP. */
  keyBy?: (request: FastifyRequest) => string;
  cost?: number;
}

/**
 * Builds the preHandler. Authenticated traffic is limited per user; anonymous
 * traffic per IP hash. For read and write classes both are checked, so one user
 * cannot exhaust a shared NAT's budget and one host cannot multiply its own by
 * creating accounts.
 *
 * Collaborators are passed explicitly rather than pulled off the instance, which
 * is what makes the hook unit-testable without a running server.
 */
export function makeRateLimitHook(
  limiter: RateLimiter,
  metrics: Metrics,
  options: RateLimitOptions,
): preHandlerHookHandler {
  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply) {
    const policy =
      options.class === 'simulation'
        ? simulationPolicy(request.entitlements)
        : options.class === 'tutor'
          ? tutorPolicy(request.entitlements)
          : POLICIES[options.class];

    const identity =
      options.keyBy?.(request) ??
      (request.auth ? `u:${request.auth.userId}` : `ip:${request.clientIpHash ?? 'unknown'}`);

    const decision = await limiter.consume({
      bucket: `${options.class}:${identity}`,
      policy,
      ...(options.cost === undefined ? {} : { cost: options.cost }),
    });

    applyHeaders(reply, decision);
    metrics.rateLimitDecisions.inc({
      class: options.class,
      decision: decision.allowed ? 'allow' : 'deny',
    });

    if (!decision.allowed) {
      throw new ApiError(
        'rate-limited',
        `Rate limit for ${options.class} exceeded. Retry in ${decision.retryAfterSeconds}s.`,
        {
          retryAfterSeconds: Math.max(1, decision.retryAfterSeconds),
          extensions: { limit: decision.limit, class: options.class },
        },
      );
    }

    // Authenticated requests additionally consume the IP budget, so a single
    // host cannot fan an attack out across many accounts.
    if (request.auth && (options.class === 'read' || options.class === 'write')) {
      const ipDecision = await limiter.consume({
        bucket: `${options.class}:ip:${request.clientIpHash ?? 'unknown'}`,
        // The shared-IP budget is deliberately generous: a lecture hall behind
        // one NAT is normal traffic, not abuse.
        policy: { ...policy, capacity: policy.capacity * 20, refillPerSecond: policy.refillPerSecond * 20 },
      });
      if (!ipDecision.allowed) {
        metrics.rateLimitDecisions.inc({ class: options.class, decision: 'deny_ip' });
        throw new ApiError('rate-limited', 'Too many requests from this network.', {
          retryAfterSeconds: Math.max(1, ipDecision.retryAfterSeconds),
        });
      }
    }
  };
}

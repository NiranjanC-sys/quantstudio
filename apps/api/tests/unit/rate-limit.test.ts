/**
 * Rate limiting (system-design §9).
 *
 *   | Endpoint class      | Limit                                          |
 *   | Read                | 120 / 10 s                                     |
 *   | Server simulation   | 30 / min (Free), 240 / min (Pro)               |
 *   | Lab submission      | 6 / min                                        |
 *   | Contest submission  | 10 / min, plus 20 s per-problem cooldown       |
 *   | AI tutor            | plan-based                                     |
 *   | Auth                | 10 / 10 min / IP, exponential backoff          |
 *
 * The policy table is asserted directly. The bucket itself is a Lua script, so
 * it is exercised against a real Redis: a token bucket that is only tested
 * against a fake has not been tested at all — the whole point of putting it in
 * Lua is that the read-modify-write is atomic on the server.
 */
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { entitlementsFor, freeSubscription, type SubscriptionState } from '../../src/entitlements/index.js';
import { createRateLimiter, POLICIES, simulationPolicy, tutorPolicy, CONTEST_PROBLEM_COOLDOWN_SECONDS } from '../../src/middleware/rate-limit.js';
import { createScriptRunner, keys } from '../../src/redis/scripts.js';
import { createMetrics } from '../../src/telemetry.js';
import { loadEnv } from '../../src/env.js';
import { HAS_REDIS, requireRedisUrl, TEST_DATABASE_URL } from '../support/environment.js';

const pro: SubscriptionState = {
  planCode: 'pro',
  status: 'active',
  seats: 1,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

describe('the §9 policy table', () => {
  it('encodes read as 120 per 10 seconds', () => {
    expect(POLICIES.read.capacity).toBe(120);
    expect(POLICIES.read.refillPerSecond * 10).toBeCloseTo(120, 6);
  });

  it('encodes lab submission as 6 per minute', () => {
    expect(POLICIES.lab_submission.capacity).toBe(6);
    expect(POLICIES.lab_submission.refillPerSecond * 60).toBeCloseTo(6, 6);
  });

  it('encodes contest submission as 10 per minute with a 20 s problem cooldown', () => {
    expect(POLICIES.contest_submission.capacity).toBe(10);
    expect(POLICIES.contest_submission.refillPerSecond * 60).toBeCloseTo(10, 6);
    expect(CONTEST_PROBLEM_COOLDOWN_SECONDS).toBe(20);
  });

  it('encodes auth as 10 per 10 minutes', () => {
    expect(POLICIES.auth.capacity).toBe(10);
    expect(POLICIES.auth.refillPerSecond * 600).toBeCloseTo(10, 6);
  });

  it('derives the simulation bucket from the plan: 30/min Free, 240/min Pro', () => {
    const free = simulationPolicy(entitlementsFor(freeSubscription()));
    expect(free.capacity).toBe(30);
    expect(free.refillPerSecond * 60).toBeCloseTo(30, 6);

    const paid = simulationPolicy(entitlementsFor(pro));
    expect(paid.capacity).toBe(240);
    expect(paid.refillPerSecond * 60).toBeCloseTo(240, 6);

    // An anonymous caller gets the Free budget rather than an unlimited one.
    expect(simulationPolicy(null).capacity).toBe(30);
  });

  it('derives the tutor bucket from the §7 messages-per-day figure', () => {
    expect(tutorPolicy(entitlementsFor(freeSubscription())).capacity).toBe(15);
    expect(tutorPolicy(entitlementsFor(pro)).capacity).toBe(300);
    expect(tutorPolicy(null).capacity).toBe(15);
  });
});

const skipRedis = !HAS_REDIS;
if (skipRedis) {
  process.stderr.write(
    '[rate-limit.test] Redis is not available; the token-bucket suite is SKIPPED.\n',
  );
}

describe.skipIf(skipRedis)('token bucket (Redis Lua)', () => {
  let redis: Redis;
  let limiter: ReturnType<typeof createRateLimiter>;
  const prefix = `test:rl:${Date.now()}:`;

  beforeAll(() => {
    redis = new Redis(requireRedisUrl(), { keyPrefix: prefix, maxRetriesPerRequest: 2 });
    const scripts = createScriptRunner(redis);
    const metrics = createMetrics(
      loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL ?? 'postgres://u:p@127.0.0.1:5432/none',
        REDIS_URL: requireRedisUrl(),
        METRICS_ENABLED: 'false',
      }),
    );
    limiter = createRateLimiter(redis, scripts, metrics, true);
  });

  afterEach(async () => {
    const found = await redis.keys(`${prefix}*`);
    if (found.length > 0) {
      // `keys` returns prefixed names but `del` re-applies the prefix.
      await redis.del(...found.map((key) => key.slice(prefix.length)));
    }
  });

  afterAll(() => {
    redis.disconnect();
  });

  it('allows exactly `capacity` requests from a cold bucket, then denies', async () => {
    const policy = { capacity: 5, refillPerSecond: 0.0001, ttlSeconds: 60 };
    const bucket = `unit:${Math.random()}`;

    for (let i = 0; i < 5; i += 1) {
      const decision = await limiter.consume({ bucket, policy });
      expect(decision.allowed).toBe(true);
      expect(decision.limit).toBe(5);
    }

    const denied = await limiter.consume({ bucket, policy });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills over time at the configured rate', async () => {
    // 10 tokens/second: after ~150 ms a single-token bucket is usable again.
    const policy = { capacity: 1, refillPerSecond: 10, ttlSeconds: 60 };
    const bucket = `refill:${Math.random()}`;

    expect((await limiter.consume({ bucket, policy })).allowed).toBe(true);
    expect((await limiter.consume({ bucket, policy })).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await limiter.consume({ bucket, policy })).allowed).toBe(true);
  });

  it('charges a multi-token cost atomically', async () => {
    const policy = { capacity: 10, refillPerSecond: 0.0001, ttlSeconds: 60 };
    const bucket = `cost:${Math.random()}`;

    const first = await limiter.consume({ bucket, policy, cost: 7 });
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(3);

    const second = await limiter.consume({ bucket, policy, cost: 7 });
    expect(second.allowed).toBe(false);
    // A denied request must not consume anything.
    expect(second.remaining).toBe(3);
  });

  it('never over-admits under a concurrent burst', async () => {
    // The property the Lua script exists for: 50 simultaneous callers against a
    // 10-token bucket must produce exactly 10 admissions, never 11.
    const policy = { capacity: 10, refillPerSecond: 0.0001, ttlSeconds: 60 };
    const bucket = `burst:${Math.random()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume({ bucket, policy })),
    );

    expect(results.filter((decision) => decision.allowed)).toHaveLength(10);
  });

  it('keeps buckets independent', async () => {
    const policy = { capacity: 1, refillPerSecond: 0.0001, ttlSeconds: 60 };
    expect((await limiter.consume({ bucket: 'a', policy })).allowed).toBe(true);
    expect((await limiter.consume({ bucket: 'a', policy })).allowed).toBe(false);
    expect((await limiter.consume({ bucket: 'b', policy })).allowed).toBe(true);
  });

  it('is a no-op when limiting is disabled', async () => {
    const scripts = createScriptRunner(redis);
    const metrics = createMetrics(
      loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL ?? 'postgres://u:p@127.0.0.1:5432/none',
        REDIS_URL: requireRedisUrl(),
        METRICS_ENABLED: 'false',
      }),
    );
    const off = createRateLimiter(redis, scripts, metrics, false);
    const policy = { capacity: 1, refillPerSecond: 0.0001, ttlSeconds: 60 };

    for (let i = 0; i < 5; i += 1) {
      expect((await off.consume({ bucket: 'disabled', policy })).allowed).toBe(true);
    }
  });

  it('applies exponential backoff to repeated auth failures, and clears it', async () => {
    const ip = `iphash-${Math.random()}`;

    // §9: "10 / 10 min / IP, exponential backoff on failure". The first two
    // failures are free — typos are not an attack.
    await limiter.recordAuthFailure(ip);
    expect(await limiter.authBackoffRemainingSeconds(ip)).toBe(0);
    await limiter.recordAuthFailure(ip);
    expect(await limiter.authBackoffRemainingSeconds(ip)).toBe(0);

    const third = await limiter.recordAuthFailure(ip);
    expect(third).toBe(8);
    expect(await limiter.authBackoffRemainingSeconds(ip)).toBeGreaterThan(0);

    const fourth = await limiter.recordAuthFailure(ip);
    expect(fourth).toBe(16);

    await limiter.clearAuthFailures(ip);
    expect(await limiter.authBackoffRemainingSeconds(ip)).toBe(0);
  });

  it('caps the auth backoff at fifteen minutes', async () => {
    const ip = `iphash-cap-${Math.random()}`;
    let backoff = 0;
    for (let i = 0; i < 14; i += 1) backoff = await limiter.recordAuthFailure(ip);
    expect(backoff).toBe(900);
  });

  it('enforces the §6 per-problem contest cooldown', async () => {
    const contestId = `c-${Math.random()}`;
    const userId = 'u-1';
    const problemId = 'p-1';

    expect(await limiter.contestCooldownRemaining(contestId, userId, problemId)).toBe(0);

    await limiter.markContestCooldown(contestId, userId, problemId);
    const remaining = await limiter.contestCooldownRemaining(contestId, userId, problemId);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(CONTEST_PROBLEM_COOLDOWN_SECONDS);

    // A different problem is unaffected.
    expect(await limiter.contestCooldownRemaining(contestId, userId, 'p-2')).toBe(0);
    // And so is a different user.
    expect(await limiter.contestCooldownRemaining(contestId, 'u-2', problemId)).toBe(0);
  });

  it('keys buckets under the rl: namespace §5 reserves for them', async () => {
    const policy = { capacity: 3, refillPerSecond: 1, ttlSeconds: 60 };
    await limiter.consume({ bucket: 'namespaced', policy });
    expect(await redis.exists(keys.rateLimit('namespaced'))).toBe(1);
  });
});

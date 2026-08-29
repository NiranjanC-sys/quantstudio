/**
 * Contest scoring under concurrency (system-design §6).
 *
 * §6 makes two claims that everything else about contests rests on:
 *
 *   "The script is idempotent under retries, which is what makes at-least-once
 *    delivery safe."
 *   "Score is only ever incremented, and only once per (user, problem), guarded
 *    by SETNX inside the same Lua script as the ZINCRBY. There is no
 *    read-modify-write from application code, so concurrent graders cannot
 *    interleave."
 *
 * The headline test fires 200 simultaneous accepted submissions for the *same*
 * (user, problem) — the exact shape of a redelivery storm from BullMQ after a
 * grader pod is rescheduled — and asserts that exactly one of them scores, that
 * the final score is the one correct value, and that a reader watching the
 * board throughout never saw it move backwards.
 *
 * This runs against a real Redis. Against a mock it would prove nothing: the
 * atomicity being tested is the Redis server's, not this code's.
 */
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAccepted,
  applyRejected,
  packScore,
  readStandings,
  unpackScore,
  type ScoringDeps,
} from '../../src/contest/scoring.js';
import { createScriptRunner, keys } from '../../src/redis/scripts.js';
import { createMetrics } from '../../src/telemetry.js';
import { loadEnv } from '../../src/env.js';
import { HAS_REDIS, requireRedisUrl, TEST_DATABASE_URL } from '../support/environment.js';

const skip = !HAS_REDIS;
if (skip) {
  process.stderr.write(
    '[contest-scoring.test] Redis is not available; the contest scoring suite is SKIPPED.\n',
  );
}

const TTL = 3_600;
const PENALTY_PER_REJECT = 1_200;

describe.skipIf(skip)('contest scoring', () => {
  let redis: Redis;
  let publisher: Redis;
  let deps: ScoringDeps;
  const prefix = `test:contest:${process.pid}:`;

  beforeAll(() => {
    redis = new Redis(requireRedisUrl(), { keyPrefix: prefix, maxRetriesPerRequest: 3 });
    publisher = new Redis(requireRedisUrl(), { keyPrefix: prefix, maxRetriesPerRequest: 3 });
    deps = {
      redis,
      publisher,
      scripts: createScriptRunner(redis),
      metrics: createMetrics(
        loadEnv({
          ...process.env,
          DATABASE_URL: TEST_DATABASE_URL ?? 'postgres://u:p@127.0.0.1:5432/none',
          REDIS_URL: requireRedisUrl(),
          METRICS_ENABLED: 'false',
        }),
      ),
    };
  });

  afterEach(async () => {
    const found = await redis.keys(`${prefix}*`);
    if (found.length > 0) {
      await redis.del(...found.map((key) => key.slice(prefix.length)));
    }
  });

  afterAll(() => {
    redis.disconnect();
    publisher.disconnect();
  });

  /**
   * The test §6 exists for.
   *
   * 200 graders deliver the same accepted submission at the same instant. The
   * SETNX guard must let exactly one of them through to the ZINCRBY, and a
   * concurrent reader must never observe the score decrease.
   */
  it('scores exactly once when 200 accepts race for the same (user, problem)', async () => {
    const contestId = 'race-contest';
    const userId = 'user-under-test';
    const problemId = 'problem-a';
    const points = 500;
    const elapsedSeconds = 1_234;
    const RACERS = 200;

    // A reader polling the board for the whole duration of the storm. Its job is
    // to catch a non-monotone intermediate state, which a read-modify-write in
    // application code would produce and an atomic script cannot.
    const observations: number[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const raw = await redis.zscore(keys.leaderboard(contestId), userId);
        observations.push(raw === null ? 0 : Number(raw));
      }
    })();

    const outcomes = await Promise.all(
      Array.from({ length: RACERS }, () =>
        applyAccepted(deps, {
          contestId,
          userId,
          problemId,
          points,
          elapsedSeconds,
          penaltySecondsPerReject: PENALTY_PER_REJECT,
          ttlSeconds: TTL,
        }),
      ),
    );

    sampling = false;
    await sampler;

    // 1. Exactly one writer won the SETNX.
    const winners = outcomes.filter((outcome) => outcome.firstAccept);
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.firstAccept)).toHaveLength(RACERS - 1);

    // 2. The board holds exactly one solve's worth of score.
    const expected = packScore(points, elapsedSeconds);
    const finalRaw = await redis.zscore(keys.leaderboard(contestId), userId);
    expect(Number(finalRaw)).toBe(expected);

    const unpacked = unpackScore(Number(finalRaw));
    expect(unpacked.points).toBe(points);
    expect(unpacked.penaltySeconds).toBe(elapsedSeconds);

    // 3. Every duplicate reported the same total, never a partial one.
    for (const outcome of outcomes) {
      expect(outcome.total.points).toBe(points);
      expect(outcome.total.penaltySeconds).toBe(elapsedSeconds);
    }

    // 4. The winner charged the penalty once; nobody else charged anything.
    expect(winners[0]?.penaltyApplied).toBe(elapsedSeconds);
    expect(
      outcomes.filter((outcome) => !outcome.firstAccept).every((o) => o.penaltyApplied === 0),
    ).toBe(true);

    // 5. Monotone: the observed score only ever went up, and only ever took one
    //    of two values — nothing partially applied was ever visible.
    expect(observations.length).toBeGreaterThan(0);
    for (let i = 1; i < observations.length; i += 1) {
      expect(observations[i] as number).toBeGreaterThanOrEqual(observations[i - 1] as number);
    }
    expect([...new Set(observations)].sort((a, b) => a - b)).toEqual(
      observations.some((value) => value === 0) ? [0, expected] : [expected],
    );

    // 6. The solved marker and the solve detail agree with the board.
    expect(await redis.get(keys.solved(contestId, userId, problemId))).toBe(
      String(elapsedSeconds),
    );
    const detail = await redis.hgetall(keys.solveDetail(contestId, userId));
    expect(detail[problemId]).toBe(`${elapsedSeconds}:0:${points}`);
  });

  it('stays correct when 200 distinct users solve the same problem at once', async () => {
    const contestId = 'fanout-contest';
    const problemId = 'problem-b';
    const points = 300;
    const USERS = 200;

    const outcomes = await Promise.all(
      Array.from({ length: USERS }, (_, index) =>
        applyAccepted(deps, {
          contestId,
          userId: `user-${index}`,
          problemId,
          // Distinct elapsed times, so the board has a total order.
          points,
          elapsedSeconds: index + 1,
          penaltySecondsPerReject: PENALTY_PER_REJECT,
          ttlSeconds: TTL,
        }),
      ),
    );

    expect(outcomes.every((outcome) => outcome.firstAccept)).toBe(true);
    expect(await redis.zcard(keys.leaderboard(contestId))).toBe(USERS);

    // Same points for everyone, so the ordering is purely by penalty: the
    // fastest solve ranks first.
    const board = await readStandings(redis, contestId, { limit: 5, offset: 0 });
    expect(board.total).toBe(USERS);
    expect(board.entries.map((entry) => entry.userId)).toEqual([
      'user-0',
      'user-1',
      'user-2',
      'user-3',
      'user-4',
    ]);
    expect(board.entries.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5]);
    for (const entry of board.entries) {
      expect(entry.points).toBe(points);
    }
  });

  it('adds up across problems and keeps the total monotone', async () => {
    const contestId = 'multi-problem';
    const userId = 'solver';

    const first = await applyAccepted(deps, {
      contestId,
      userId,
      problemId: 'A',
      points: 100,
      elapsedSeconds: 60,
      penaltySecondsPerReject: PENALTY_PER_REJECT,
      ttlSeconds: TTL,
    });
    expect(first.total.points).toBe(100);
    expect(first.total.penaltySeconds).toBe(60);

    const second = await applyAccepted(deps, {
      contestId,
      userId,
      problemId: 'B',
      points: 250,
      elapsedSeconds: 900,
      penaltySecondsPerReject: PENALTY_PER_REJECT,
      ttlSeconds: TTL,
    });

    expect(second.total.points).toBe(350);
    expect(second.total.penaltySeconds).toBe(960);
    // Strictly greater: more points always outranks more penalty.
    expect(second.total.raw).toBeGreaterThan(first.total.raw);
  });

  /** ICPC semantics: rejected attempts before a solve cost 20 minutes each. */
  it('charges the ICPC penalty for rejected attempts made before the solve', async () => {
    const contestId = 'penalty-contest';
    const userId = 'penalised';
    const problemId = 'C';

    expect(
      await applyRejected(deps, { contestId, userId, problemId, ttlSeconds: TTL }),
    ).toBe(1);
    expect(
      await applyRejected(deps, { contestId, userId, problemId, ttlSeconds: TTL }),
    ).toBe(2);

    const accepted = await applyAccepted(deps, {
      contestId,
      userId,
      problemId,
      points: 400,
      elapsedSeconds: 300,
      penaltySecondsPerReject: PENALTY_PER_REJECT,
      ttlSeconds: TTL,
    });

    expect(accepted.firstAccept).toBe(true);
    expect(accepted.penaltyApplied).toBe(300 + 2 * PENALTY_PER_REJECT);
    expect(accepted.total.points).toBe(400);
    expect(accepted.total.penaltySeconds).toBe(300 + 2 * PENALTY_PER_REJECT);
  });

  it('makes attempts after a solve free', async () => {
    const contestId = 'post-solve';
    const userId = 'already-solved';
    const problemId = 'D';

    await applyAccepted(deps, {
      contestId,
      userId,
      problemId,
      points: 100,
      elapsedSeconds: 10,
      penaltySecondsPerReject: PENALTY_PER_REJECT,
      ttlSeconds: TTL,
    });

    const before = await redis.zscore(keys.leaderboard(contestId), userId);
    for (let i = 0; i < 5; i += 1) {
      await applyRejected(deps, { contestId, userId, problemId, ttlSeconds: TTL });
    }
    const after = await redis.zscore(keys.leaderboard(contestId), userId);

    expect(after).toBe(before);
    expect(unpackScore(Number(after)).penaltySeconds).toBe(10);
  });

  it('is idempotent across a simulated grader restart', async () => {
    const contestId = 'redelivery';
    const userId = 'retried';
    const problemId = 'E';

    const input = {
      contestId,
      userId,
      problemId,
      points: 750,
      elapsedSeconds: 2_500,
      penaltySecondsPerReject: PENALTY_PER_REJECT,
      ttlSeconds: TTL,
    };

    const first = await applyAccepted(deps, input);
    // Ten redeliveries, spread over time rather than concurrent — the other
    // shape at-least-once delivery takes.
    for (let i = 0; i < 10; i += 1) {
      const repeat = await applyAccepted(deps, input);
      expect(repeat.firstAccept).toBe(false);
      expect(repeat.total.raw).toBe(first.total.raw);
    }

    expect(Number(await redis.zscore(keys.leaderboard(contestId), userId))).toBe(
      packScore(750, 2_500),
    );
  });

  it('gives every key a TTL so a finished contest does not leak keyspace', async () => {
    const contestId = 'ttl-contest';
    const userId = 'ttl-user';
    const problemId = 'F';

    await applyRejected(deps, { contestId, userId, problemId, ttlSeconds: TTL });
    await applyAccepted(deps, {
      contestId,
      userId,
      problemId,
      points: 100,
      elapsedSeconds: 5,
      penaltySecondsPerReject: PENALTY_PER_REJECT,
      ttlSeconds: TTL,
    });

    for (const key of [
      keys.leaderboard(contestId),
      keys.solved(contestId, userId, problemId),
      keys.solveDetail(contestId, userId),
      keys.attempts(contestId, userId, problemId),
    ]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(TTL);
    }
  });

  it('pins every key of one contest to a single Redis Cluster slot', () => {
    // §6's script mutates four keys atomically, which is only legal on a cluster
    // if they hash to the same slot. The `{contest}` tag is what guarantees it.
    const contestId = 'slot-check';
    const tag = `{${contestId}}`;
    expect(keys.leaderboard(contestId)).toContain(tag);
    expect(keys.solved(contestId, 'u', 'p')).toContain(tag);
    expect(keys.solveDetail(contestId, 'u')).toContain(tag);
    expect(keys.attempts(contestId, 'u', 'p')).toContain(tag);
  });

  it('round-trips the packed score for every plausible contest', () => {
    for (const points of [0, 1, 4, 17, 100, 4_000]) {
      for (const penalty of [0, 1, 59, 3_600, 18_000, 250_000]) {
        if (points === 0 && penalty > 0) continue;
        const packed = packScore(points, penalty);
        const unpacked = unpackScore(packed);
        expect(unpacked.points).toBe(points);
        expect(unpacked.penaltySeconds).toBe(penalty);
        expect(Number.isSafeInteger(packed)).toBe(true);
      }
    }
  });

  it('ranks strictly by points first and penalty second', () => {
    // The invariant the packing exists for: one more point always beats any
    // amount of accumulated penalty.
    expect(packScore(2, 0)).toBeGreaterThan(packScore(1, 0));
    expect(packScore(2, 4_000_000)).toBeGreaterThan(packScore(1, 0));
    expect(packScore(1, 10)).toBeGreaterThan(packScore(1, 11));
  });
});

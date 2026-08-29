/**
 * Contest scoring (system-design §6).
 *
 * The whole correctness argument lives here, and it is short:
 *
 *   - A score is only ever *incremented*, never recomputed, so the board is
 *     monotone by construction.
 *   - The increment is guarded by `SETNX solved:{contest}:{user}:{problem}`
 *     inside the *same* Lua script as the `ZINCRBY lb:{contest}` (see
 *     `CONTEST_SCORE_LUA`), so a (user, problem) pair can contribute at most
 *     once, no matter how many graders deliver the same accept concurrently.
 *   - Because the guard is idempotent, at-least-once delivery from BullMQ is
 *     safe: a redelivered accept is a no-op that returns the existing score.
 *
 * Nothing in this module does a read-modify-write from application code. The
 * only Redis calls that decide anything are the two scripts.
 */
import type { Redis } from 'ioredis';
import type { ScriptRunner } from '../redis/scripts.js';
import { keys } from '../redis/scripts.js';
import type { Metrics } from '../telemetry.js';

/** ZSET scores pack `points * 2^32 - penalty_seconds` (§5). */
export const POINT_SHIFT = 4_294_967_296;

export interface PackedScore {
  points: number;
  penaltySeconds: number;
  raw: number;
}

/**
 * Unpacks a leaderboard score. Exact for every value the product can produce:
 * total penalty seconds are bounded by the contest length plus 20 minutes per
 * rejected attempt, which is many orders of magnitude below 2^32, and the packed
 * value stays inside the 53-bit integer range of a ZSET double.
 */
export function unpackScore(raw: number): PackedScore {
  if (raw <= 0) return { points: 0, penaltySeconds: raw < 0 ? -raw : 0, raw };
  const points = Math.ceil(raw / POINT_SHIFT);
  return { points, penaltySeconds: points * POINT_SHIFT - raw, raw };
}

export function packScore(points: number, penaltySeconds: number): number {
  return points * POINT_SHIFT - penaltySeconds;
}

export interface ContestWindow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  freezeMinutes: number;
  penaltySecondsPerReject: number;
}

/** §6: the public board freezes `freezeMinutes` before the end (default 60). */
export function freezeAt(contest: ContestWindow): Date {
  return new Date(contest.endsAt.getTime() - contest.freezeMinutes * 60_000);
}

export function isFrozen(contest: ContestWindow, now: Date = new Date()): boolean {
  return now >= freezeAt(contest) && now < contest.endsAt;
}

export function isRunning(contest: ContestWindow, now: Date = new Date()): boolean {
  return now >= contest.startsAt && now < contest.endsAt;
}

/**
 * How long the contest's Redis keys must survive. The finaliser reads the ZSET
 * after the contest ends, and the post-contest replay (§9 SLOs) wants the solve
 * detail for a while afterwards, so the TTL runs to 30 days past the end.
 */
export function keyTtlSeconds(contest: ContestWindow, now: Date = new Date()): number {
  const until = contest.endsAt.getTime() + 30 * 24 * 3_600_000;
  return Math.max(3_600, Math.ceil((until - now.getTime()) / 1000));
}

export interface AcceptInput {
  contestId: string;
  userId: string;
  problemId: string;
  points: number;
  /** Seconds from the contest start (or from the virtual start). */
  elapsedSeconds: number;
  penaltySecondsPerReject: number;
  ttlSeconds: number;
}

export interface AcceptOutcome {
  /** False when this (user, problem) was already solved — a safe duplicate. */
  firstAccept: boolean;
  /** The user's total score after the operation, unpacked. */
  total: PackedScore;
  /** Penalty charged by this accept (0 on a duplicate). */
  penaltyApplied: number;
}

export interface ScoringDeps {
  redis: Redis;
  scripts: ScriptRunner;
  metrics: Metrics;
  /** Separate connection so a slow subscriber cannot stall the publish (§5). */
  publisher: Redis;
}

/**
 * Applies an accepted submission. Idempotent: calling it a thousand times with
 * the same (contest, user, problem) increments the board exactly once.
 */
export async function applyAccepted(
  deps: ScoringDeps,
  input: AcceptInput,
): Promise<AcceptOutcome> {
  const [firstAccept, score, penalty] = await deps.scripts.contestScore(
    [
      keys.solved(input.contestId, input.userId, input.problemId),
      keys.leaderboard(input.contestId),
      keys.solveDetail(input.contestId, input.userId),
      keys.attempts(input.contestId, input.userId, input.problemId),
    ],
    [
      input.userId,
      input.points,
      input.elapsedSeconds,
      input.penaltySecondsPerReject,
      input.problemId,
      input.ttlSeconds,
    ],
  );

  deps.metrics.contestScoreOps.inc({ result: firstAccept === 1 ? 'first_accept' : 'duplicate' });

  return {
    firstAccept: firstAccept === 1,
    total: unpackScore(Number(score)),
    penaltyApplied: firstAccept === 1 ? Number(penalty) : 0,
  };
}

/**
 * Records a rejected attempt so a later accept carries the ICPC penalty.
 * Attempts made after the problem is already solved are free, which the Lua
 * script enforces rather than the caller.
 */
export async function applyRejected(
  deps: ScoringDeps,
  input: { contestId: string; userId: string; problemId: string; ttlSeconds: number },
): Promise<number> {
  return deps.scripts.contestReject(
    [
      keys.solved(input.contestId, input.userId, input.problemId),
      keys.attempts(input.contestId, input.userId, input.problemId),
    ],
    input.ttlSeconds,
  );
}

export interface BoardDelta {
  kind: 'delta';
  contestId: string;
  userId: string;
  problemId: string;
  points: number;
  penaltySeconds: number;
  at: number;
}

/**
 * Publishes a leaderboard delta on `ws:contest:{id}` for the broadcaster to fan
 * out (§6 step 4). Suppressed once the board is frozen: the ZSET keeps updating,
 * the public view does not.
 */
export async function publishDelta(
  deps: ScoringDeps,
  contest: ContestWindow,
  delta: Omit<BoardDelta, 'kind' | 'at'>,
  now: Date = new Date(),
): Promise<boolean> {
  if (isFrozen(contest, now)) return false;
  const message: BoardDelta = { kind: 'delta', ...delta, at: now.getTime() };
  await deps.publisher.publish(keys.wsContest(contest.id), JSON.stringify(message));
  return true;
}

export interface StandingsEntry {
  rank: number;
  userId: string;
  points: number;
  penaltySeconds: number;
  solved: Record<string, { solvedAt: number; attempts: number; points: number }>;
}

function parseSolveDetail(
  hash: Record<string, string>,
): StandingsEntry['solved'] {
  const solved: StandingsEntry['solved'] = {};
  for (const [problemId, packed] of Object.entries(hash)) {
    const [elapsed, attempts, points] = packed.split(':');
    solved[problemId] = {
      solvedAt: Number(elapsed ?? 0),
      attempts: Number(attempts ?? 0),
      points: Number(points ?? 0),
    };
  }
  return solved;
}

/**
 * Reads a page of the live board straight out of Redis: `ZREVRANGE` is O(log N +
 * M), so rank lookup stays O(1)-ish even with 50k participants (§5).
 *
 * Ties share a rank, which is what makes the board monotone from the client's
 * point of view: two users with identical points and penalty never swap places
 * between two reads of the same state.
 */
export async function readStandings(
  redis: Redis,
  contestId: string,
  options: { limit: number; offset: number; withDetail?: boolean },
): Promise<{ entries: StandingsEntry[]; total: number }> {
  const board = keys.leaderboard(contestId);
  const total = await redis.zcard(board);
  if (total === 0) return { entries: [], total: 0 };

  const flat = await redis.zrevrange(
    board,
    options.offset,
    options.offset + options.limit - 1,
    'WITHSCORES',
  );

  const raw: Array<{ userId: string; score: number }> = [];
  for (let i = 0; i < flat.length; i += 2) {
    raw.push({ userId: flat[i] as string, score: Number(flat[i + 1]) });
  }

  // The rank of the first row on this page is its absolute index, adjusted so
  // that a tie spanning the page boundary still reports the same rank.
  let rank = options.offset + 1;
  if (options.offset > 0 && raw.length > 0) {
    const better = await redis.zcount(board, `(${raw[0]?.score ?? 0}`, '+inf');
    rank = better + 1;
  }

  const details = options.withDetail
    ? await Promise.all(
        raw.map((row) => redis.hgetall(keys.solveDetail(contestId, row.userId))),
      )
    : [];

  const entries: StandingsEntry[] = [];
  let previousScore: number | null = null;
  let previousRank = rank;

  raw.forEach((row, index) => {
    const unpacked = unpackScore(row.score);
    const thisRank =
      previousScore !== null && row.score === previousScore ? previousRank : rank + index;
    previousScore = row.score;
    previousRank = thisRank;
    entries.push({
      rank: thisRank,
      userId: row.userId,
      points: unpacked.points,
      penaltySeconds: unpacked.penaltySeconds,
      solved: options.withDetail ? parseSolveDetail(details[index] ?? {}) : {},
    });
  });

  return { entries, total };
}

/** Whole-board read, used by the finaliser. Streams in pages so 50k rows is fine. */
export async function readWholeBoard(
  redis: Redis,
  contestId: string,
): Promise<StandingsEntry[]> {
  const out: StandingsEntry[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { entries, total } = await readStandings(redis, contestId, {
      limit: pageSize,
      offset,
      withDetail: true,
    });
    out.push(...entries);
    if (out.length >= total || entries.length === 0) break;
  }
  return out;
}

/**
 * The write side of `progress` (system-design §5).
 *
 * Two things here are load-bearing:
 *
 *  1. `progress.mastery.unlocked_lesson_ids` is the "hot-path denormalisation"
 *     §5 calls for, and §5 also says it "is recomputed transactionally whenever a
 *     lesson completes". `completeLesson` therefore does the whole thing —
 *     lesson state, XP, streak, concept mastery, review scheduling and the DAG
 *     recompute — inside one transaction, with the mastery row's `version`
 *     column as an optimistic guard against a concurrent recompute.
 *
 *  2. The lesson graph is read-mostly and fully cacheable, so it is loaded once
 *     per process (behind a Redis-shared copy) rather than per completion.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DatabaseHandles, Queryable } from '../db/client.js';
import {
  concepts as conceptsTable,
  lessonConcepts,
  lessonPrereqs,
  lessons,
} from '../db/schema/catalog.js';
import {
  conceptMastery,
  lessonState,
  mastery,
  reviewQueue,
  streaks,
  xpEvents,
} from '../db/schema/progress.js';
import { ApiError } from '../errors.js';
import { computeUnlocked, type LessonNode } from '../lib/dag.js';
import { bktUpdateGraded, decayMastery, type BktParameters } from '../lib/mastery.js';
import { DEFAULT_SCHEDULE, initialState, intervalForHalfLife } from '../lib/spaced-repetition.js';
import { keys } from '../redis/scripts.js';

const GRAPH_CACHE_KEY = 'lesson-graph';
const GRAPH_TTL_SECONDS = 300;

export interface LessonGraph {
  nodes: LessonNode[];
  byId: Map<number, LessonNode>;
}

interface GraphPayload {
  nodes: LessonNode[];
}

/**
 * Loads the lesson DAG. Three flat queries and an in-memory join beats a
 * recursive CTE here: the whole graph is 331 lessons, and the result is cached.
 */
export async function loadLessonGraph(
  db: DatabaseHandles,
  redis: Redis,
): Promise<LessonGraph> {
  const cacheKey = keys.catalogCache(GRAPH_CACHE_KEY);

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      const payload = JSON.parse(cached) as GraphPayload;
      return { nodes: payload.nodes, byId: new Map(payload.nodes.map((n) => [n.id, n])) };
    } catch {
      // Fall through and rebuild.
    }
  }

  const [lessonRows, prereqRows, conceptRows] = await Promise.all([
    db.replica
      .select({
        id: lessons.id,
        moduleId: lessons.moduleId,
        kind: lessons.kind,
        position: lessons.position,
      })
      .from(lessons),
    db.replica
      .select({
        lessonId: lessonPrereqs.lessonId,
        prereqLessonId: lessonPrereqs.prereqLessonId,
        hard: lessonPrereqs.hard,
      })
      .from(lessonPrereqs),
    db.replica
      .select({ lessonId: lessonConcepts.lessonId, conceptId: lessonConcepts.conceptId })
      .from(lessonConcepts),
  ]);

  const nodes = new Map<number, LessonNode>();
  for (const row of lessonRows) {
    nodes.set(row.id, {
      id: row.id,
      moduleId: row.moduleId,
      kind: row.kind,
      position: row.position,
      prereqs: [],
      softPrereqs: [],
      conceptIds: [],
    });
  }
  for (const row of prereqRows) {
    const node = nodes.get(row.lessonId);
    if (!node) continue;
    (row.hard ? node.prereqs : node.softPrereqs).push(row.prereqLessonId);
  }
  for (const row of conceptRows) {
    nodes.get(row.lessonId)?.conceptIds.push(row.conceptId);
  }

  const list = [...nodes.values()].sort((a, b) => a.id - b.id);
  await redis
    .set(cacheKey, JSON.stringify({ nodes: list } satisfies GraphPayload), 'EX', GRAPH_TTL_SECONDS)
    .catch(() => undefined);

  return { nodes: list, byId: nodes };
}

export interface MasteryRow {
  userId: string;
  unlockedLessonIds: number[];
  completedLessonIds: number[];
  overallMastery: number;
  lessonsCompleted: number;
  version: number;
}

/** Reads the single denormalised row §5 designs the "what next" query around. */
export async function readMastery(handle: Queryable, userId: string): Promise<MasteryRow> {
  const rows = await handle
    .select({
      userId: mastery.userId,
      unlockedLessonIds: mastery.unlockedLessonIds,
      completedLessonIds: mastery.completedLessonIds,
      overallMastery: mastery.overallMastery,
      lessonsCompleted: mastery.lessonsCompleted,
      version: mastery.version,
    })
    .from(mastery)
    .where(eq(mastery.userId, userId))
    .limit(1);

  const row = rows[0];
  if (row) return row;

  throw new ApiError(
    'internal-error',
    'Mastery row is missing for this user; it is created at signup.',
  );
}

/**
 * Recomputes the unlocked frontier and writes it back. The `version` predicate is
 * the optimistic lock: if another transaction recomputed in the meantime this
 * update matches nothing and the caller retries with fresh input, which is
 * cheaper and safer than holding a row lock across a graph walk.
 */
export async function recomputeUnlocked(
  tx: Queryable,
  userId: string,
  graph: LessonGraph,
  completed: Set<number>,
  expectedVersion: number,
): Promise<{ unlocked: number[]; applied: boolean }> {
  const { unlocked } = computeUnlocked({ lessons: graph.nodes, completed });
  const total = graph.nodes.length;

  const updated = await tx
    .update(mastery)
    .set({
      unlockedLessonIds: unlocked,
      completedLessonIds: [...completed].sort((a, b) => a - b),
      lessonsCompleted: completed.size,
      overallMastery: total === 0 ? 0 : Math.min(1, completed.size / total),
      version: expectedVersion + 1,
      recomputedAt: new Date(),
    })
    .where(and(eq(mastery.userId, userId), eq(mastery.version, expectedVersion)))
    .returning({ version: mastery.version });

  return { unlocked, applied: updated.length > 0 };
}

export type XpKind =
  | 'lesson_complete'
  | 'lab_pass'
  | 'checkpoint_pass'
  | 'project_pass'
  | 'review'
  | 'contest'
  | 'streak_bonus'
  | 'adjustment';

/**
 * Appends an XP event. The global and per-institution leaderboards are Redis
 * sorted sets kept in step here, so `GET /leaderboard/global` is a ZREVRANGE
 * rather than an aggregate over a partitioned table.
 */
export async function awardXp(
  tx: Queryable,
  input: {
    userId: string;
    amount: number;
    kind: XpKind;
    refType?: string | null;
    refId?: string | null;
  },
): Promise<void> {
  if (input.amount === 0) return;
  await tx.insert(xpEvents).values({
    userId: input.userId,
    amount: input.amount,
    kind: input.kind,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
  });
}

export async function bumpXpLeaderboards(
  redis: Redis,
  userId: string,
  orgId: string | null,
  amount: number,
): Promise<void> {
  const pipeline = redis.multi();
  pipeline.zincrby(keys.globalLeaderboard(), amount, userId);
  if (orgId) pipeline.zincrby(keys.institutionLeaderboard(orgId), amount, userId);
  await pipeline.exec().catch(() => undefined);
}

export interface StreakResult {
  current: number;
  longest: number;
  lastActiveDate: string;
  /** True when this call extended the streak, so XP can award a bonus once. */
  extended: boolean;
  freezeUsed: boolean;
}

/** The learner's local calendar date, which is what a streak is actually about. */
export function localDate(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(now);
  }
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Advances the streak. A single missed day can be absorbed by a freeze token —
 * the product's forgiveness mechanic — and anything longer resets to 1.
 */
export async function touchStreak(
  tx: Queryable,
  userId: string,
  now: Date = new Date(),
): Promise<StreakResult> {
  const rows = await tx
    .select({
      current: streaks.current,
      longest: streaks.longest,
      lastActiveDate: streaks.lastActiveDate,
      freezeTokens: streaks.freezeTokens,
      timezone: streaks.timezone,
    })
    .from(streaks)
    .where(eq(streaks.userId, userId))
    .for('update');

  const row = rows[0];
  if (!row) {
    throw new ApiError('internal-error', 'Streak row is missing; it is created at signup.');
  }

  const today = localDate(now, row.timezone);

  if (row.lastActiveDate === today) {
    return {
      current: row.current,
      longest: row.longest,
      lastActiveDate: today,
      extended: false,
      freezeUsed: false,
    };
  }

  const gap = row.lastActiveDate ? daysBetween(row.lastActiveDate, today) : Number.POSITIVE_INFINITY;

  let current: number;
  let freezeUsed = false;
  let freezeTokens = row.freezeTokens;

  if (gap === 1) {
    current = row.current + 1;
  } else if (gap === 2 && freezeTokens > 0) {
    current = row.current + 1;
    freezeTokens -= 1;
    freezeUsed = true;
  } else {
    current = 1;
  }

  const longest = Math.max(row.longest, current);

  await tx
    .update(streaks)
    .set({ current, longest, lastActiveDate: today, freezeTokens, updatedAt: now })
    .where(eq(streaks.userId, userId));

  return { current, longest, lastActiveDate: today, extended: true, freezeUsed };
}

export interface CompleteLessonInput {
  userId: string;
  lessonId: number;
  /** 0-1. A checkpoint below its `pass_threshold` is recorded but not completed. */
  score: number;
  secondsSpent: number;
}

export interface CompleteLessonResult {
  status: 'completed' | 'failed';
  xpAwarded: number;
  streak: StreakResult;
  unlocked: number[];
  newlyUnlocked: number[];
  conceptMastery: Array<{ conceptId: number; mastery: number }>;
  reviewDueAt: string | null;
}

/**
 * The transaction §5 describes. Everything a completion touches is written here
 * or nowhere: partial completion is exactly the state that makes the unlocked
 * array lie, and the array is what the whole "what next" path trusts.
 */
export async function completeLesson(
  db: DatabaseHandles,
  graph: LessonGraph,
  input: CompleteLessonInput,
): Promise<CompleteLessonResult> {
  const node = graph.byId.get(input.lessonId);
  if (!node) throw new ApiError('not-found', 'Lesson was not found.');

  const lessonRows = await db.primary
    .select({
      id: lessons.id,
      xp: lessons.xp,
      kind: lessons.kind,
      passThreshold: lessons.passThreshold,
    })
    .from(lessons)
    .where(eq(lessons.id, input.lessonId))
    .limit(1);

  const lesson = lessonRows[0];
  if (!lesson) throw new ApiError('not-found', 'Lesson was not found.');

  const passed = input.score >= lesson.passThreshold;
  const now = new Date();

  return db.primary.transaction(async (tx) => {
    const current = await readMastery(tx, input.userId);
    const completed = new Set(current.completedLessonIds);

    // §5 says a lesson opens only when its hard prerequisites are complete. The
    // check lives here, not only in the route, so no path can bypass it.
    const missing = node.prereqs.filter((prereq) => !completed.has(prereq));
    if (missing.length > 0) {
      throw new ApiError('prerequisites-unmet', 'Complete the prerequisite lessons first.', {
        extensions: { missingLessonIds: missing },
      });
    }

    const previous = await tx
      .select({ attempts: lessonState.attempts, bestScore: lessonState.bestScore })
      .from(lessonState)
      .where(and(eq(lessonState.userId, input.userId), eq(lessonState.lessonId, input.lessonId)))
      .limit(1);

    const attempts = (previous[0]?.attempts ?? 0) + 1;
    const bestScore = Math.max(previous[0]?.bestScore ?? 0, input.score);
    const alreadyCompleted = completed.has(input.lessonId);

    await tx
      .insert(lessonState)
      .values({
        userId: input.userId,
        lessonId: input.lessonId,
        status: passed ? 'completed' : 'failed',
        score: input.score,
        bestScore,
        attempts,
        secondsSpent: input.secondsSpent,
        completedAt: passed ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [lessonState.userId, lessonState.lessonId],
        set: {
          status: passed ? 'completed' : 'failed',
          score: input.score,
          bestScore,
          attempts,
          secondsSpent: sql`${lessonState.secondsSpent} + ${input.secondsSpent}`,
          completedAt: passed ? now : null,
          updatedAt: now,
        },
      });

    // ---------------------------------------------------- concept mastery (BKT)
    const conceptRows =
      node.conceptIds.length === 0
        ? []
        : await tx
            .select({
              id: conceptsTable.id,
              prior: conceptsTable.priorMastery,
              learn: conceptsTable.learnRate,
              slip: conceptsTable.slipRate,
              guess: conceptsTable.guessRate,
            })
            .from(conceptsTable)
            .where(inArray(conceptsTable.id, node.conceptIds));

    const existingMastery =
      node.conceptIds.length === 0
        ? []
        : await tx
            .select({
              conceptId: conceptMastery.conceptId,
              mastery: conceptMastery.mastery,
              halfLifeHours: conceptMastery.halfLifeHours,
              observations: conceptMastery.observations,
              correct: conceptMastery.correct,
              lastInteractionAt: conceptMastery.lastInteractionAt,
            })
            .from(conceptMastery)
            .where(
              and(
                eq(conceptMastery.userId, input.userId),
                inArray(conceptMastery.conceptId, node.conceptIds),
              ),
            );

    const masteryByConcept = new Map(existingMastery.map((row) => [row.conceptId, row]));
    const updatedConcepts: Array<{ conceptId: number; mastery: number }> = [];

    for (const concept of conceptRows) {
      const params: BktParameters = {
        prior: concept.prior,
        learn: concept.learn,
        slip: concept.slip,
        guess: concept.guess,
      };
      const existing = masteryByConcept.get(concept.id);
      const hoursElapsed = existing
        ? (now.getTime() - existing.lastInteractionAt.getTime()) / 3_600_000
        : 0;

      // Decay first, then observe: the learner's state at the moment of the
      // attempt is what the observation updates.
      const decayed = existing
        ? decayMastery(existing.mastery, hoursElapsed, existing.halfLifeHours, concept.prior)
        : concept.prior;

      const next = bktUpdateGraded(decayed, input.score, params);
      // A successful review extends the half-life; a failure shortens it.
      const halfLife = Math.max(
        1,
        (existing?.halfLifeHours ?? DEFAULT_SCHEDULE.initialHalfLifeHours) *
          (passed ? 1.6 : DEFAULT_SCHEDULE.lapsePenalty),
      );

      await tx
        .insert(conceptMastery)
        .values({
          userId: input.userId,
          conceptId: concept.id,
          mastery: next,
          halfLifeHours: halfLife,
          observations: 1,
          correct: passed ? 1 : 0,
          lastInteractionAt: now,
        })
        .onConflictDoUpdate({
          target: [conceptMastery.userId, conceptMastery.conceptId],
          set: {
            mastery: next,
            halfLifeHours: halfLife,
            observations: sql`${conceptMastery.observations} + 1`,
            correct: sql`${conceptMastery.correct} + ${passed ? 1 : 0}`,
            lastInteractionAt: now,
          },
        });

      updatedConcepts.push({ conceptId: concept.id, mastery: next });
    }

    // ----------------------------------------------------------- XP and streak
    let xpAwarded = 0;
    let streak: StreakResult = {
      current: 0,
      longest: 0,
      lastActiveDate: localDate(now, 'UTC'),
      extended: false,
      freezeUsed: false,
    };

    if (passed && !alreadyCompleted) {
      xpAwarded = lesson.xp;
      const kind: XpKind =
        lesson.kind === 'checkpoint'
          ? 'checkpoint_pass'
          : lesson.kind === 'project'
            ? 'project_pass'
            : lesson.kind === 'lab'
              ? 'lab_pass'
              : 'lesson_complete';

      await awardXp(tx, {
        userId: input.userId,
        amount: xpAwarded,
        kind,
        refType: 'lesson',
        refId: String(input.lessonId),
      });
    }

    if (passed) {
      streak = await touchStreak(tx, input.userId, now);
      // Every seventh day is worth a bonus; without it a streak is a number with
      // no consequence.
      if (streak.extended && streak.current > 0 && streak.current % 7 === 0) {
        const bonus = 25;
        xpAwarded += bonus;
        await awardXp(tx, {
          userId: input.userId,
          amount: bonus,
          kind: 'streak_bonus',
          refType: 'streak',
          refId: String(streak.current),
        });
      }
    }

    // ------------------------------------------------------- review scheduling
    let reviewDueAt: string | null = null;
    if (passed) {
      const schedule = initialState();
      const dueAt = new Date(now.getTime() + schedule.intervalHours * 3_600_000);
      reviewDueAt = dueAt.toISOString();

      await tx
        .insert(reviewQueue)
        .values({
          userId: input.userId,
          lessonId: input.lessonId,
          conceptId: node.conceptIds[0] ?? null,
          dueAt,
          intervalHours: schedule.intervalHours,
          halfLifeHours: schedule.halfLifeHours,
          ease: schedule.ease,
          repetitions: 0,
          lapses: 0,
          lastReviewedAt: now,
        })
        .onConflictDoUpdate({
          target: [reviewQueue.userId, reviewQueue.lessonId],
          set: {
            dueAt,
            intervalHours: schedule.intervalHours,
            halfLifeHours: schedule.halfLifeHours,
            suspended: false,
            lastReviewedAt: now,
          },
        });
    }

    // ------------------------------------------------------- DAG recompute (§5)
    let unlocked = current.unlockedLessonIds;
    let newlyUnlocked: number[] = [];

    if (passed && !alreadyCompleted) {
      const nextCompleted = new Set(completed);
      nextCompleted.add(input.lessonId);

      const result = await recomputeUnlocked(
        tx,
        input.userId,
        graph,
        nextCompleted,
        current.version,
      );
      if (!result.applied) {
        // Serialisable in effect: the row moved under us, so abort rather than
        // write a frontier computed from stale input.
        throw new ApiError('conflict', 'Your progress changed concurrently; retry the request.', {
          retryAfterSeconds: 1,
        });
      }

      const before = new Set(current.unlockedLessonIds);
      unlocked = result.unlocked;
      newlyUnlocked = result.unlocked.filter((id) => !before.has(id));
    }

    return {
      status: passed ? ('completed' as const) : ('failed' as const),
      xpAwarded,
      streak,
      unlocked,
      newlyUnlocked,
      conceptMastery: updatedConcepts,
      reviewDueAt,
    };
  });
}

export { intervalForHalfLife };

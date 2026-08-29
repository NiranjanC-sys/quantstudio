/**
 * Learner progress: lesson state, mastery, the spaced-repetition review queue,
 * streaks, XP, and "what should I do next" answered from the DAG.
 *
 * The read paths are deliberately cheap. §5's whole point in materialising
 * `unlocked_lesson_ids` is that the next-lesson question is a single row read;
 * this module keeps that promise and only walks the graph when it has to rank
 * candidates by concept mastery.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { lessons, modules, tracks } from '../db/schema/catalog.js';
import {
  conceptMastery,
  enrollments,
  lessonState,
  reviewQueue,
  streaks,
  xpEvents,
} from '../db/schema/progress.js';
import { canReadTrack } from '../entitlements/index.js';
import { problem } from '../errors.js';
import { recommendNext } from '../lib/dag.js';
import { decayMastery, retrievability } from '../lib/mastery.js';
import { orderDueQueue, reviewItem, type ReviewGrade } from '../lib/spaced-repetition.js';
import {
  awardXp,
  bumpXpLeaderboards,
  completeLesson,
  loadLessonGraph,
  readMastery,
} from '../progress/service.js';
import {
  authed,
  page,
  paginationSchema,
  rateLimit,
  readBody,
  readParams,
  readQuery,
  useIdempotency,
} from './helpers.js';

const lessonIdSchema = z.object({ lessonId: z.coerce.number().int().positive() });

const completeSchema = z.object({
  score: z.number().min(0).max(1),
  secondsSpent: z.number().int().min(0).max(86_400).default(0),
});

const heartbeatSchema = z.object({
  secondsSpent: z.number().int().min(0).max(3_600).default(0),
  status: z.enum(['in_progress', 'available']).default('in_progress'),
});

const reviewGradeSchema = z.object({
  grade: z.enum(['again', 'hard', 'good', 'easy']),
});

export const progressRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis } = app.services;

  useIdempotency(app);
  const readLimit = rateLimit(app, 'read');
  const writeLimit = rateLimit(app, 'write');

  /** Concept mastery decayed to "now", which is what any decision should use. */
  async function currentConceptMastery(
    userId: string,
    now: Date,
  ): Promise<Map<number, number>> {
    const rows = await db.read(true)
      .select({
        conceptId: conceptMastery.conceptId,
        mastery: conceptMastery.mastery,
        halfLifeHours: conceptMastery.halfLifeHours,
        lastInteractionAt: conceptMastery.lastInteractionAt,
      })
      .from(conceptMastery)
      .where(eq(conceptMastery.userId, userId));

    return new Map(
      rows.map((row) => [
        row.conceptId,
        decayMastery(
          row.mastery,
          (now.getTime() - row.lastInteractionAt.getTime()) / 3_600_000,
          row.halfLifeHours,
        ),
      ]),
    );
  }

  app.get('/overview', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const now = new Date();

    const [masteryRow, streakRows, xpRows, dueCount] = await Promise.all([
      readMastery(db.read(request.readFromPrimary), auth.userId),
      db.read(request.readFromPrimary)
        .select({
          current: streaks.current,
          longest: streaks.longest,
          lastActiveDate: streaks.lastActiveDate,
          freezeTokens: streaks.freezeTokens,
          timezone: streaks.timezone,
        })
        .from(streaks)
        .where(eq(streaks.userId, auth.userId))
        .limit(1),
      db.read(request.readFromPrimary)
        .select({ total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)::int` })
        .from(xpEvents)
        .where(eq(xpEvents.userId, auth.userId)),
      db.read(request.readFromPrimary)
        .select({ total: sql<number>`count(*)::int` })
        .from(reviewQueue)
        .where(
          and(
            eq(reviewQueue.userId, auth.userId),
            eq(reviewQueue.suspended, false),
            lte(reviewQueue.dueAt, now),
          ),
        ),
    ]);

    return reply.send({
      mastery: {
        overall: masteryRow.overallMastery,
        lessonsCompleted: masteryRow.lessonsCompleted,
        unlockedCount: masteryRow.unlockedLessonIds.length,
        version: masteryRow.version,
      },
      streak: streakRows[0] ?? {
        current: 0,
        longest: 0,
        lastActiveDate: null,
        freezeTokens: 0,
        timezone: 'UTC',
      },
      xp: { total: xpRows[0]?.total ?? 0 },
      reviewsDue: dueCount[0]?.total ?? 0,
    });
  });

  app.get('/mastery', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const now = new Date();
    const masteryRow = await readMastery(db.read(request.readFromPrimary), auth.userId);
    const byConcept = await currentConceptMastery(auth.userId, now);

    return reply.send({
      overall: masteryRow.overallMastery,
      lessonsCompleted: masteryRow.lessonsCompleted,
      unlockedLessonIds: masteryRow.unlockedLessonIds,
      completedLessonIds: masteryRow.completedLessonIds,
      concepts: [...byConcept.entries()].map(([conceptId, value]) => ({
        conceptId,
        mastery: value,
      })),
    });
  });

  /**
   * The next-lesson recommendation. §5's single-row read gives the candidate
   * set; the syllabus' `argmin(mastery)` rule ranks it.
   */
  app.get('/next', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { limit } = readQuery(
      request,
      z.object({ limit: z.coerce.number().int().min(1).max(10).default(3) }),
    );

    const now = new Date();
    const [graph, masteryRow, conceptState] = await Promise.all([
      loadLessonGraph(db, redis.client),
      readMastery(db.read(request.readFromPrimary), auth.userId),
      currentConceptMastery(auth.userId, now),
    ]);

    const recommendations = recommendNext({
      lessons: graph.nodes,
      completed: masteryRow.completedLessonIds,
      conceptMastery: conceptState,
      limit,
    });

    if (recommendations.length === 0) {
      return reply.send({ items: [], reason: 'nothing-unlocked' });
    }

    const detail = await db.read(request.readFromPrimary)
      .select({
        id: lessons.id,
        slug: lessons.slug,
        title: lessons.title,
        kind: lessons.kind,
        estimatedMinutes: lessons.estimatedMinutes,
        xp: lessons.xp,
        moduleCode: modules.code,
        trackCode: tracks.code,
      })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .innerJoin(tracks, eq(tracks.id, modules.trackId))
      .where(inArray(lessons.id, recommendations.map((r) => r.lessonId)));

    const byId = new Map(detail.map((row) => [row.id, row]));

    return reply.send({
      items: recommendations
        .map((recommendation) => {
          const lesson = byId.get(recommendation.lessonId);
          if (!lesson) return null;
          return {
            ...lesson,
            score: recommendation.score,
            reason: recommendation.reason,
            readable: request.entitlements
              ? canReadTrack(request.entitlements, lesson.trackCode)
              : false,
          };
        })
        .filter((item) => item !== null),
      reason: 'dag',
    });
  });

  app.get('/lessons/:lessonId', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { lessonId } = readParams(request, lessonIdSchema);

    const rows = await db.read(request.readFromPrimary)
      .select()
      .from(lessonState)
      .where(and(eq(lessonState.userId, auth.userId), eq(lessonState.lessonId, lessonId)))
      .limit(1);

    const masteryRow = await readMastery(db.read(request.readFromPrimary), auth.userId);

    return reply.send({
      state: rows[0] ?? null,
      unlocked: masteryRow.unlockedLessonIds.includes(lessonId),
      completed: masteryRow.completedLessonIds.includes(lessonId),
    });
  });

  /** Time-on-task heartbeat. Cheap, frequent, and never changes the DAG. */
  app.patch('/lessons/:lessonId', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { lessonId } = readParams(request, lessonIdSchema);
    const input = readBody(request, heartbeatSchema);

    const exists = await db.primary
      .select({ id: lessons.id })
      .from(lessons)
      .where(eq(lessons.id, lessonId))
      .limit(1);
    if (exists.length === 0) throw problem.notFound('Lesson');

    const now = new Date();
    const updated = await db.primary
      .insert(lessonState)
      .values({
        userId: auth.userId,
        lessonId,
        status: input.status,
        secondsSpent: input.secondsSpent,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [lessonState.userId, lessonState.lessonId],
        set: {
          // A completed lesson stays completed; a heartbeat cannot demote it.
          status: sql`case when ${lessonState.status} = 'completed' then ${lessonState.status} else ${input.status}::progress.lesson_status end`,
          secondsSpent: sql`${lessonState.secondsSpent} + ${input.secondsSpent}`,
          updatedAt: now,
        },
      })
      .returning({
        status: lessonState.status,
        secondsSpent: lessonState.secondsSpent,
      });

    return reply.send({ state: updated[0] ?? null });
  });

  app.post('/lessons/:lessonId/complete', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { lessonId } = readParams(request, lessonIdSchema);
    const input = readBody(request, completeSchema);

    const graph = await loadLessonGraph(db, redis.client);
    const result = await completeLesson(db, graph, {
      userId: auth.userId,
      lessonId,
      score: input.score,
      secondsSpent: input.secondsSpent,
    });

    if (result.xpAwarded > 0) {
      await bumpXpLeaderboards(redis.client, auth.userId, auth.orgId, result.xpAwarded);
    }

    return reply.send(result);
  });

  // ------------------------------------------------------- review queue (SRS)

  app.get('/review-queue', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const query = readQuery(
      request,
      paginationSchema.extend({
        /** `due` is the study session; `all` is the whole schedule. */
        scope: z.enum(['due', 'all']).default('due'),
      }),
    );

    const now = new Date();
    const filters = [eq(reviewQueue.userId, auth.userId), eq(reviewQueue.suspended, false)];
    if (query.scope === 'due') filters.push(lte(reviewQueue.dueAt, now));

    const rows = await db.read(request.readFromPrimary)
      .select({
        id: reviewQueue.id,
        lessonId: reviewQueue.lessonId,
        conceptId: reviewQueue.conceptId,
        dueAt: reviewQueue.dueAt,
        intervalHours: reviewQueue.intervalHours,
        halfLifeHours: reviewQueue.halfLifeHours,
        ease: reviewQueue.ease,
        repetitions: reviewQueue.repetitions,
        lapses: reviewQueue.lapses,
        lastReviewedAt: reviewQueue.lastReviewedAt,
        lessonSlug: lessons.slug,
        lessonTitle: lessons.title,
      })
      .from(reviewQueue)
      .innerJoin(lessons, eq(lessons.id, reviewQueue.lessonId))
      .where(and(...filters))
      .orderBy(asc(reviewQueue.dueAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.read(request.readFromPrimary)
      .select({ total: sql<number>`count(*)::int` })
      .from(reviewQueue)
      .where(and(...filters));

    // Ordered by the forgetting curve: least likely to be recalled first, so the
    // session spends its time where forgetting is actually happening.
    const ordered = orderDueQueue(rows, now).map((row) => ({
      ...row,
      dueAt: row.dueAt.toISOString(),
      lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
      predictedRecall: retrievability(
        (now.getTime() - row.dueAt.getTime()) / 3_600_000,
        row.halfLifeHours,
      ),
    }));

    return reply.send(page(ordered, query, counted[0]?.total ?? 0));
  });

  app.post('/review-queue/:id/grade', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { id } = readParams(request, z.object({ id: z.string().uuid() }));
    const { grade } = readBody(request, reviewGradeSchema);

    const now = new Date();

    const result = await db.primary.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: reviewQueue.id,
          lessonId: reviewQueue.lessonId,
          conceptId: reviewQueue.conceptId,
          halfLifeHours: reviewQueue.halfLifeHours,
          intervalHours: reviewQueue.intervalHours,
          ease: reviewQueue.ease,
          repetitions: reviewQueue.repetitions,
          lapses: reviewQueue.lapses,
          lastReviewedAt: reviewQueue.lastReviewedAt,
        })
        .from(reviewQueue)
        .where(and(eq(reviewQueue.id, id), eq(reviewQueue.userId, auth.userId)))
        .for('update');

      const item = rows[0];
      if (!item) throw problem.notFound('Review item');

      const hoursSince = item.lastReviewedAt
        ? (now.getTime() - item.lastReviewedAt.getTime()) / 3_600_000
        : 0;

      const outcome = reviewItem(
        {
          halfLifeHours: item.halfLifeHours,
          intervalHours: item.intervalHours,
          ease: item.ease,
          repetitions: item.repetitions,
          lapses: item.lapses,
        },
        grade as ReviewGrade,
        now,
        hoursSince,
      );

      await tx
        .update(reviewQueue)
        .set({
          dueAt: outcome.dueAt,
          intervalHours: outcome.state.intervalHours,
          halfLifeHours: outcome.state.halfLifeHours,
          ease: outcome.state.ease,
          repetitions: outcome.state.repetitions,
          lapses: outcome.state.lapses,
          lastReviewedAt: now,
        })
        .where(eq(reviewQueue.id, item.id));

      // A successful review extends the concept's half-life too, which is what
      // the syllabus means by "extends with each successful spaced review".
      if (item.conceptId !== null && grade !== 'again') {
        await tx
          .update(conceptMastery)
          .set({
            halfLifeHours: outcome.state.halfLifeHours,
            lastInteractionAt: now,
            observations: sql`${conceptMastery.observations} + 1`,
            correct: sql`${conceptMastery.correct} + 1`,
          })
          .where(
            and(
              eq(conceptMastery.userId, auth.userId),
              eq(conceptMastery.conceptId, item.conceptId),
            ),
          );
      }

      // A review is worth a little XP; without it the queue competes with new
      // lessons for the learner's attention and always loses.
      const xp = grade === 'again' ? 0 : 5;
      if (xp > 0) {
        await awardXp(tx, {
          userId: auth.userId,
          amount: xp,
          kind: 'review',
          refType: 'review',
          refId: item.id,
        });
      }

      return {
        dueAt: outcome.dueAt.toISOString(),
        intervalHours: outcome.state.intervalHours,
        halfLifeHours: outcome.state.halfLifeHours,
        ease: outcome.state.ease,
        repetitions: outcome.state.repetitions,
        lapses: outcome.state.lapses,
        retrievabilityAtReview: outcome.retrievabilityAtReview,
        xpAwarded: xp,
      };
    });

    if (result.xpAwarded > 0) {
      await bumpXpLeaderboards(redis.client, auth.userId, auth.orgId, result.xpAwarded);
    }

    return reply.send(result);
  });

  // ------------------------------------------------------------- streak / XP

  app.get('/streak', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const rows = await db.read(request.readFromPrimary)
      .select()
      .from(streaks)
      .where(eq(streaks.userId, auth.userId))
      .limit(1);
    const row = rows[0];
    if (!row) throw problem.notFound('Streak');
    return reply.send({
      current: row.current,
      longest: row.longest,
      lastActiveDate: row.lastActiveDate,
      freezeTokens: row.freezeTokens,
      timezone: row.timezone,
    });
  });

  app.put('/streak/timezone', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { timezone } = readBody(
      request,
      z.object({
        timezone: z.string().min(1).max(64).refine(
          (value) => {
            try {
              new Intl.DateTimeFormat('en-CA', { timeZone: value });
              return true;
            } catch {
              return false;
            }
          },
          { message: 'Unknown IANA time zone.' },
        ),
      }),
    );

    await db.primary
      .update(streaks)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(streaks.userId, auth.userId));

    return reply.send({ timezone });
  });

  app.get('/xp', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const query = readQuery(
      request,
      paginationSchema.extend({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    );

    const since = new Date(Date.now() - query.days * 86_400_000);

    const [total, recent, byKind] = await Promise.all([
      db.read(request.readFromPrimary)
        .select({ total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)::int` })
        .from(xpEvents)
        .where(eq(xpEvents.userId, auth.userId)),
      db.read(request.readFromPrimary)
        .select({
          amount: xpEvents.amount,
          kind: xpEvents.kind,
          refType: xpEvents.refType,
          refId: xpEvents.refId,
          createdAt: xpEvents.createdAt,
        })
        .from(xpEvents)
        .where(and(eq(xpEvents.userId, auth.userId), gte(xpEvents.createdAt, since)))
        .orderBy(desc(xpEvents.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.read(request.readFromPrimary)
        .select({
          kind: xpEvents.kind,
          amount: sql<number>`coalesce(sum(${xpEvents.amount}), 0)::int`,
        })
        .from(xpEvents)
        .where(and(eq(xpEvents.userId, auth.userId), gte(xpEvents.createdAt, since)))
        .groupBy(xpEvents.kind),
    ]);

    return reply.send({
      total: total[0]?.total ?? 0,
      windowDays: query.days,
      byKind,
      events: recent.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  });

  // ------------------------------------------------------------- enrollments

  app.get('/enrollments', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const rows = await db.read(request.readFromPrimary)
      .select({
        id: enrollments.id,
        trackId: enrollments.trackId,
        trackCode: tracks.code,
        trackTitle: tracks.title,
        status: enrollments.status,
        startedAt: enrollments.startedAt,
        completedAt: enrollments.completedAt,
      })
      .from(enrollments)
      .innerJoin(tracks, eq(tracks.id, enrollments.trackId))
      .where(eq(enrollments.userId, auth.userId))
      .orderBy(asc(tracks.position));

    return reply.send({ items: rows });
  });

  app.post('/enrollments', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { trackCode } = readBody(
      request,
      z.object({ trackCode: z.string().regex(/^T[0-9]$/) }),
    );

    const trackRows = await db.primary
      .select({ id: tracks.id, code: tracks.code })
      .from(tracks)
      .where(eq(tracks.code, trackCode))
      .limit(1);

    const track = trackRows[0];
    if (!track) throw problem.notFound('Track');

    if (request.entitlements && !canReadTrack(request.entitlements, track.code)) {
      throw problem.forbidden(`Your plan does not include ${track.code}.`);
    }

    const inserted = await db.primary
      .insert(enrollments)
      .values({ userId: auth.userId, trackId: track.id })
      .onConflictDoNothing()
      .returning({ id: enrollments.id });

    return reply.status(inserted[0] ? 201 : 200).send({
      enrolled: true,
      trackCode: track.code,
      created: inserted.length > 0,
    });
  });
};

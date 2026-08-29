/**
 * The instructor dashboard (system-design §7: Teams and Campus only).
 *
 * Cohorts, assignments, a gradebook and the per-concept mastery heatmap. The
 * heatmap stores nothing of its own — it is a join from cohort membership onto
 * `progress.concept_mastery`, decayed to "now" by the same forgetting curve the
 * learner sees, so an instructor can never be shown a mastery figure the learner
 * would disagree with.
 *
 * Every route is gated twice: by the `instructor.dashboard` entitlement (§7) and
 * by role, which also forces the MFA §8 requires of instructors and org admins.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { concepts, lessons } from '../db/schema/catalog.js';
import { orgs, users } from '../db/schema/identity.js';
import {
  assignmentGrades,
  assignments,
  cohortMembers,
  cohorts,
} from '../db/schema/instructor.js';
import { conceptMastery, lessonState } from '../db/schema/progress.js';
import { assertFeature } from '../entitlements/index.js';
import { ApiError, problem } from '../errors.js';
import { decayMastery } from '../lib/mastery.js';
import { requireRole } from '../middleware/auth.js';
import {
  authed,
  csvRows,
  paginationSchema,
  rateLimit,
  readBody,
  readParams,
  readQuery,
  useIdempotency,
} from './helpers.js';

const cohortIdSchema = z.object({ cohortId: z.string().uuid() });

const createCohortSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  term: z.string().trim().max(64).optional(),
  trackCode: z.string().regex(/^T[0-9]$/).optional(),
});

const assignmentSchema = z.object({
  title: z.string().trim().min(2).max(200),
  instructions: z.string().max(20_000).optional(),
  lessonIds: z.array(z.number().int().positive()).max(200).default([]),
  points: z.number().int().min(1).max(10_000).default(100),
  dueAt: z.coerce.date().optional(),
  published: z.boolean().default(false),
});

const gradeSchema = z.object({
  score: z.number().min(0).max(1).nullable(),
  status: z.enum(['not_started', 'in_progress', 'submitted', 'graded', 'excused']),
  feedback: z.string().max(10_000).optional(),
});

/** `A1B2C3` — short enough to read out in a lecture, long enough not to guess. */
function generateJoinCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)] as string;
  }
  return code;
}

export const instructorRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.services;

  useIdempotency(app);
  const readLimit = rateLimit(app, 'read');
  const writeLimit = rateLimit(app, 'write');

  /** Learner-facing: joining a cohort needs no instructor entitlement. */
  app.post('/join', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { joinCode } = readBody(
      request,
      z.object({ joinCode: z.string().regex(/^[A-Z0-9]{6,12}$/) }),
    );

    const rows = await db.primary
      .select({ id: cohorts.id, name: cohorts.name, orgId: cohorts.orgId })
      .from(cohorts)
      .where(and(eq(cohorts.joinCode, joinCode), eq(cohorts.archived, false)))
      .limit(1);

    const cohort = rows[0];
    if (!cohort) throw problem.notFound('Cohort');

    await db.primary
      .insert(cohortMembers)
      .values({ cohortId: cohort.id, userId: auth.userId, role: 'student' })
      .onConflictDoUpdate({
        target: [cohortMembers.cohortId, cohortMembers.userId],
        set: { removedAt: null },
      });

    return reply.status(201).send({ cohortId: cohort.id, name: cohort.name });
  });

  /**
   * Everything below is instructor-only. The hook runs the §7 entitlement check
   * and the §8 role/MFA check for every route in this scope, so a new endpoint
   * cannot be added ungated by accident.
   */
  app.addHook('preHandler', async (request: FastifyRequest) => {
    if (request.routeOptions?.url?.endsWith('/join')) return;
    const auth = requireRole(request, 'instructor', 'org_admin', 'admin');
    assertFeature(request.entitlements ?? auth.entitlements, 'instructor.dashboard');
  });

  /**
   * Loads a cohort the caller is allowed to act on. An admin sees every cohort;
   * an org admin sees their organisation's; an instructor sees the ones they own
   * or assist on.
   */
  async function authoriseCohort(request: FastifyRequest, cohortId: string) {
    const auth = authed(request);
    const rows = await db.primary
      .select({
        id: cohorts.id,
        orgId: cohorts.orgId,
        ownerId: cohorts.ownerId,
        name: cohorts.name,
        slug: cohorts.slug,
        term: cohorts.term,
        trackId: cohorts.trackId,
        joinCode: cohorts.joinCode,
        archived: cohorts.archived,
        createdAt: cohorts.createdAt,
      })
      .from(cohorts)
      .where(eq(cohorts.id, cohortId))
      .limit(1);

    const cohort = rows[0];
    if (!cohort) throw problem.notFound('Cohort');

    if (auth.role === 'admin') return cohort;
    if (auth.orgId !== cohort.orgId) {
      throw problem.forbidden('This cohort belongs to another organisation.');
    }
    if (auth.role === 'org_admin' || cohort.ownerId === auth.userId) return cohort;

    const assisting = await db.primary
      .select({ userId: cohortMembers.userId })
      .from(cohortMembers)
      .where(
        and(
          eq(cohortMembers.cohortId, cohortId),
          eq(cohortMembers.userId, auth.userId),
          eq(cohortMembers.role, 'assistant'),
        ),
      )
      .limit(1);

    if (assisting.length === 0) {
      throw problem.forbidden('You do not teach this cohort.');
    }
    return cohort;
  }

  async function activeMembers(cohortId: string) {
    return db.primary
      .select({
        userId: cohortMembers.userId,
        role: cohortMembers.role,
        joinedAt: cohortMembers.joinedAt,
        handle: users.handle,
        displayName: users.displayName,
        email: users.email,
      })
      .from(cohortMembers)
      .innerJoin(users, eq(users.id, cohortMembers.userId))
      .where(and(eq(cohortMembers.cohortId, cohortId), isNull(cohortMembers.removedAt)))
      .orderBy(asc(users.displayName));
  }

  // ----------------------------------------------------------------- cohorts

  app.post('/cohorts', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const input = readBody(request, createCohortSchema);

    if (!auth.orgId) {
      throw new ApiError('conflict', 'Cohorts belong to an organisation and you are not in one.');
    }

    let trackId: number | null = null;
    if (input.trackCode) {
      const { tracks } = await import('../db/schema/catalog.js');
      const trackRows = await db.primary
        .select({ id: tracks.id })
        .from(tracks)
        .where(eq(tracks.code, input.trackCode))
        .limit(1);
      trackId = trackRows[0]?.id ?? null;
      if (trackId === null) throw problem.notFound('Track');
    }

    const inserted = await db.primary
      .insert(cohorts)
      .values({
        orgId: auth.orgId,
        ownerId: auth.userId,
        name: input.name,
        slug: input.slug,
        term: input.term ?? null,
        trackId,
        joinCode: generateJoinCode(),
      })
      .onConflictDoNothing({ target: [cohorts.orgId, cohorts.slug] })
      .returning({ id: cohorts.id, joinCode: cohorts.joinCode });

    const cohort = inserted[0];
    if (!cohort) throw new ApiError('conflict', 'A cohort with that slug already exists.');

    return reply.status(201).send({ id: cohort.id, joinCode: cohort.joinCode });
  });

  app.get('/cohorts', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const query = readQuery(
      request,
      paginationSchema.extend({ includeArchived: z.coerce.boolean().default(false) }),
    );

    // An instructor who belongs to no organisation owns no cohorts. Comparing
    // the uuid column against `''` would be a 500, not an empty page.
    if (auth.role !== 'admin' && !auth.orgId) {
      return reply.send({ items: [] });
    }

    const filters =
      auth.role === 'admin' ? [] : [eq(cohorts.orgId, auth.orgId as string)];
    if (!query.includeArchived) filters.push(eq(cohorts.archived, false));

    const rows = await db.primary
      .select({
        id: cohorts.id,
        name: cohorts.name,
        slug: cohorts.slug,
        term: cohorts.term,
        trackId: cohorts.trackId,
        joinCode: cohorts.joinCode,
        archived: cohorts.archived,
        createdAt: cohorts.createdAt,
        orgName: orgs.name,
        memberCount: sql<number>`(
          select count(*)::int from instructor.cohort_members m
          where m.cohort_id = ${cohorts.id} and m.removed_at is null
        )`,
      })
      .from(cohorts)
      .innerJoin(orgs, eq(orgs.id, cohorts.orgId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(cohorts.name))
      .limit(query.limit)
      .offset(query.offset);

    return reply.send({ items: rows });
  });

  app.get('/cohorts/:cohortId', { preHandler: [readLimit] }, async (request, reply) => {
    const { cohortId } = readParams(request, cohortIdSchema);
    const cohort = await authoriseCohort(request, cohortId);
    const members = await activeMembers(cohortId);

    const assignmentRows = await db.primary
      .select({
        id: assignments.id,
        title: assignments.title,
        points: assignments.points,
        dueAt: assignments.dueAt,
        published: assignments.published,
        lessonIds: assignments.lessonIds,
      })
      .from(assignments)
      .where(eq(assignments.cohortId, cohortId))
      .orderBy(asc(assignments.dueAt));

    return reply.send({ cohort, members, assignments: assignmentRows });
  });

  app.post('/cohorts/:cohortId/members', { preHandler: [writeLimit] }, async (request, reply) => {
    const { cohortId } = readParams(request, cohortIdSchema);
    const cohort = await authoriseCohort(request, cohortId);

    const input = readBody(
      request,
      z.object({
        emails: z.array(z.string().email().max(320)).min(1).max(500),
        role: z.enum(['student', 'assistant']).default('student'),
      }),
    );

    const normalised = input.emails.map((email) => email.toLowerCase());
    /**
     * Tenant isolation: an address is only resolvable inside the cohort's own
     * organisation. Without the `orgId` predicate an instructor could name any
     * account on the platform and then read that learner's email and per-concept
     * mastery out of the gradebook and the heatmap. A learner who is not (yet) a
     * member of the organisation enrols themselves with the join code instead,
     * which is the path where they consent.
     */
    const found = await db.primary
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          eq(users.orgId, cohort.orgId),
          inArray(sql`lower(${users.email})`, normalised),
        ),
      );

    const foundEmails = new Set(found.map((row) => row.email.toLowerCase()));
    const missing = normalised.filter((email) => !foundEmails.has(email));

    if (found.length > 0) {
      await db.primary
        .insert(cohortMembers)
        .values(
          found.map((row) => ({ cohortId, userId: row.id, role: input.role })),
        )
        .onConflictDoUpdate({
          target: [cohortMembers.cohortId, cohortMembers.userId],
          set: { role: input.role, removedAt: null },
        });
    }

    return reply.status(201).send({ added: found.length, notFound: missing });
  });

  app.delete(
    '/cohorts/:cohortId/members/:userId',
    { preHandler: [writeLimit] },
    async (request, reply) => {
      const { cohortId, userId } = readParams(
        request,
        cohortIdSchema.extend({ userId: z.string().uuid() }),
      );
      await authoriseCohort(request, cohortId);

      // Soft removal: a grade already recorded must survive the student leaving.
      const updated = await db.primary
        .update(cohortMembers)
        .set({ removedAt: new Date() })
        .where(and(eq(cohortMembers.cohortId, cohortId), eq(cohortMembers.userId, userId)))
        .returning({ userId: cohortMembers.userId });

      if (updated.length === 0) throw problem.notFound('Cohort member');
      return reply.status(204).send();
    },
  );

  // ------------------------------------------------------------- assignments

  app.post('/cohorts/:cohortId/assignments', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { cohortId } = readParams(request, cohortIdSchema);
    await authoriseCohort(request, cohortId);
    const input = readBody(request, assignmentSchema);

    if (input.lessonIds.length > 0) {
      const existing = await db.primary
        .select({ id: lessons.id })
        .from(lessons)
        .where(inArray(lessons.id, input.lessonIds));
      if (existing.length !== input.lessonIds.length) {
        throw new ApiError('validation-failed', 'One or more lesson ids do not exist.', {
          extensions: {
            unknown: input.lessonIds.filter(
              (id) => !existing.some((lesson) => lesson.id === id),
            ),
          },
        });
      }
    }

    const inserted = await db.primary
      .insert(assignments)
      .values({
        cohortId,
        title: input.title,
        instructions: input.instructions ?? null,
        lessonIds: input.lessonIds,
        points: input.points,
        dueAt: input.dueAt ?? null,
        published: input.published,
        createdBy: auth.userId,
      })
      .returning({ id: assignments.id });

    return reply.status(201).send({ id: inserted[0]?.id });
  });

  app.patch('/assignments/:assignmentId', { preHandler: [writeLimit] }, async (request, reply) => {
    const { assignmentId } = readParams(request, z.object({ assignmentId: z.string().uuid() }));
    const input = readBody(request, assignmentSchema.partial());

    const rows = await db.primary
      .select({ cohortId: assignments.cohortId })
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);

    const owner = rows[0];
    if (!owner) throw problem.notFound('Assignment');
    await authoriseCohort(request, owner.cohortId);

    await db.primary
      .update(assignments)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.lessonIds === undefined ? {} : { lessonIds: input.lessonIds }),
        ...(input.points === undefined ? {} : { points: input.points }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.published === undefined ? {} : { published: input.published }),
        updatedAt: new Date(),
      })
      .where(eq(assignments.id, assignmentId));

    return reply.send({ updated: true });
  });

  app.put(
    '/assignments/:assignmentId/grades/:userId',
    { preHandler: [writeLimit] },
    async (request, reply) => {
      const auth = authed(request);
      const { assignmentId, userId } = readParams(
        request,
        z.object({ assignmentId: z.string().uuid(), userId: z.string().uuid() }),
      );
      const input = readBody(request, gradeSchema);

      const rows = await db.primary
        .select({ cohortId: assignments.cohortId })
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .limit(1);

      const owner = rows[0];
      if (!owner) throw problem.notFound('Assignment');
      await authoriseCohort(request, owner.cohortId);

      // The graded user is an identifier from the caller, so it is constrained
      // to the cohort rather than merely being a valid uuid: without this an
      // instructor could write a grade row against any account on the platform.
      const member = await db.primary
        .select({ userId: cohortMembers.userId })
        .from(cohortMembers)
        .where(
          and(
            eq(cohortMembers.cohortId, owner.cohortId),
            eq(cohortMembers.userId, userId),
            isNull(cohortMembers.removedAt),
          ),
        )
        .limit(1);
      if (member.length === 0) throw problem.notFound('Cohort member');

      if (input.status === 'graded' && input.score === null) {
        throw new ApiError('validation-failed', 'A graded assignment needs a score.');
      }

      const now = new Date();
      await db.primary
        .insert(assignmentGrades)
        .values({
          assignmentId,
          userId,
          status: input.status,
          score: input.score,
          feedback: input.feedback ?? null,
          gradedBy: auth.userId,
          gradedAt: input.status === 'graded' ? now : null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [assignmentGrades.assignmentId, assignmentGrades.userId],
          set: {
            status: input.status,
            score: input.score,
            feedback: input.feedback ?? null,
            gradedBy: auth.userId,
            gradedAt: input.status === 'graded' ? now : null,
            updatedAt: now,
          },
        });

      return reply.send({ graded: true });
    },
  );

  // --------------------------------------------------------------- gradebook

  /**
   * The gradebook. Each cell carries both the recorded score and the score the
   * platform would compute from lesson completion, so an instructor can see at a
   * glance where a manual override diverges from the learner's actual work.
   */
  async function buildGradebook(cohortId: string) {
    const [members, assignmentRows] = await Promise.all([
      activeMembers(cohortId),
      db.primary
        .select({
          id: assignments.id,
          title: assignments.title,
          points: assignments.points,
          dueAt: assignments.dueAt,
          lessonIds: assignments.lessonIds,
          published: assignments.published,
        })
        .from(assignments)
        .where(eq(assignments.cohortId, cohortId))
        .orderBy(asc(assignments.dueAt), asc(assignments.title)),
    ]);

    const userIds = members.map((member) => member.userId);
    const assignmentIds = assignmentRows.map((row) => row.id);
    const allLessonIds = [...new Set(assignmentRows.flatMap((row) => row.lessonIds))];

    const [grades, completions] = await Promise.all([
      assignmentIds.length === 0 || userIds.length === 0
        ? []
        : db.primary
            .select({
              assignmentId: assignmentGrades.assignmentId,
              userId: assignmentGrades.userId,
              status: assignmentGrades.status,
              score: assignmentGrades.score,
              feedback: assignmentGrades.feedback,
              gradedAt: assignmentGrades.gradedAt,
            })
            .from(assignmentGrades)
            .where(
              and(
                inArray(assignmentGrades.assignmentId, assignmentIds),
                inArray(assignmentGrades.userId, userIds),
              ),
            ),
      allLessonIds.length === 0 || userIds.length === 0
        ? []
        : db.primary
            .select({
              userId: lessonState.userId,
              lessonId: lessonState.lessonId,
              bestScore: lessonState.bestScore,
              status: lessonState.status,
            })
            .from(lessonState)
            .where(
              and(
                inArray(lessonState.userId, userIds),
                inArray(lessonState.lessonId, allLessonIds),
              ),
            ),
    ]);

    const gradeIndex = new Map(grades.map((row) => [`${row.assignmentId}:${row.userId}`, row]));
    const completionIndex = new Map(
      completions.map((row) => [`${row.userId}:${row.lessonId}`, row]),
    );

    const rows = members.map((member) => {
      const cells = assignmentRows.map((assignment) => {
        const recorded = gradeIndex.get(`${assignment.id}:${member.userId}`);

        // Auto score: the mean best-score over the assignment's lessons, with a
        // lesson never attempted counting as zero.
        const autoScore =
          assignment.lessonIds.length === 0
            ? null
            : assignment.lessonIds.reduce((sum, lessonId) => {
                const state = completionIndex.get(`${member.userId}:${lessonId}`);
                return sum + (state?.status === 'completed' ? state.bestScore ?? 1 : 0);
              }, 0) / assignment.lessonIds.length;

        return {
          assignmentId: assignment.id,
          status: recorded?.status ?? 'not_started',
          score: recorded?.score ?? null,
          autoScore,
          effectiveScore: recorded?.score ?? autoScore,
          feedback: recorded?.feedback ?? null,
          gradedAt: recorded?.gradedAt?.toISOString() ?? null,
        };
      });

      const weighted = cells.reduce(
        (acc, cell, index) => {
          const points = assignmentRows[index]?.points ?? 0;
          if (cell.effectiveScore === null) return acc;
          return { earned: acc.earned + cell.effectiveScore * points, possible: acc.possible + points };
        },
        { earned: 0, possible: 0 },
      );

      return {
        userId: member.userId,
        handle: member.handle,
        displayName: member.displayName,
        email: member.email,
        cells,
        overall: weighted.possible === 0 ? null : weighted.earned / weighted.possible,
      };
    });

    return { assignments: assignmentRows, rows };
  }

  app.get('/cohorts/:cohortId/gradebook', { preHandler: [readLimit] }, async (request, reply) => {
    const { cohortId } = readParams(request, cohortIdSchema);
    await authoriseCohort(request, cohortId);
    return reply.send(await buildGradebook(cohortId));
  });

  app.get('/cohorts/:cohortId/export.csv', { preHandler: [readLimit] }, async (request, reply) => {
    const { cohortId } = readParams(request, cohortIdSchema);
    const cohort = await authoriseCohort(request, cohortId);
    const gradebook = await buildGradebook(cohortId);

    const header: Array<string | number | null> = [
      'student',
      'handle',
      'email',
      ...gradebook.assignments.map((assignment) => assignment.title),
      'overall',
    ];

    const body = gradebook.rows.map((row) => [
      row.displayName,
      row.handle,
      row.email,
      ...row.cells.map((cell) =>
        cell.effectiveScore === null ? '' : Number(cell.effectiveScore.toFixed(4)),
      ),
      row.overall === null ? '' : Number(row.overall.toFixed(4)),
    ]);

    return reply
      .type('text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${cohort.slug}-gradebook.csv"`,
      )
      .send(csvRows([header, ...body]));
  });

  /**
   * Per-concept mastery heatmap. One query per side and an in-memory pivot: the
   * alternative — a crosstab in SQL — would need the concept list at plan time,
   * and the concept list is exactly what the cohort's work determines.
   */
  app.get('/cohorts/:cohortId/heatmap', { preHandler: [readLimit] }, async (request, reply) => {
    const { cohortId } = readParams(request, cohortIdSchema);
    await authoriseCohort(request, cohortId);

    const members = await activeMembers(cohortId);
    const userIds = members.map((member) => member.userId);

    if (userIds.length === 0) {
      return reply.send({ concepts: [], students: [], cells: [] });
    }

    const rows = await db.primary
      .select({
        userId: conceptMastery.userId,
        conceptId: conceptMastery.conceptId,
        mastery: conceptMastery.mastery,
        halfLifeHours: conceptMastery.halfLifeHours,
        lastInteractionAt: conceptMastery.lastInteractionAt,
        observations: conceptMastery.observations,
        conceptSlug: concepts.slug,
        conceptTitle: concepts.title,
      })
      .from(conceptMastery)
      .innerJoin(concepts, eq(concepts.id, conceptMastery.conceptId))
      .where(inArray(conceptMastery.userId, userIds));

    const now = new Date();
    const conceptIndex = new Map<number, { id: number; slug: string; title: string }>();
    const cells = rows.map((row) => {
      conceptIndex.set(row.conceptId, {
        id: row.conceptId,
        slug: row.conceptSlug,
        title: row.conceptTitle,
      });
      return {
        userId: row.userId,
        conceptId: row.conceptId,
        mastery: decayMastery(
          row.mastery,
          (now.getTime() - row.lastInteractionAt.getTime()) / 3_600_000,
          row.halfLifeHours,
        ),
        observations: row.observations,
      };
    });

    const conceptList = [...conceptIndex.values()].sort((a, b) => a.id - b.id);

    // Cohort-level summary, which is what an instructor actually acts on: the
    // concepts where the class as a whole is weakest.
    const summary = conceptList.map((concept) => {
      const values = cells
        .filter((cell) => cell.conceptId === concept.id)
        .map((cell) => cell.mastery);
      const mean = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
      const belowThreshold = values.filter((value) => value < 0.7).length;
      return {
        ...concept,
        mean,
        coverage: values.length / members.length,
        strugglingCount: belowThreshold,
      };
    });

    summary.sort((a, b) => a.mean - b.mean);

    return reply.send({
      concepts: conceptList,
      students: members.map((member) => ({
        userId: member.userId,
        handle: member.handle,
        displayName: member.displayName,
      })),
      cells,
      summary,
      weakest: summary.slice(0, 10),
    });
  });
};

/**
 * Operator surface: user administration, contest authoring, moderation, the
 * §9 degradation ladder and the queue/webhook views an on-call engineer needs
 * during an incident.
 *
 * Everything here requires the `admin` role, which — through `requireRole` —
 * also requires the MFA §8 mandates for privileged accounts.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reconciliationRuns, stripeEvents } from '../db/schema/billing.js';
import { contests, problems } from '../db/schema/contest.js';
import { orgs, users } from '../db/schema/identity.js';
import { comments, discussions, reports } from '../db/schema/social.js';
import { ApiError, problem } from '../errors.js';
import { degradationSchema, createDegradationController } from '../lib/degradation.js';
import { requireRole } from '../middleware/auth.js';
import {
  page,
  paginationSchema,
  rateLimit,
  readBody,
  readParams,
  readQuery,
  useIdempotency,
} from './helpers.js';

const createContestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(20_000).optional(),
  kind: z.enum(['rated', 'unrated', 'private']).default('rated'),
  orgId: z.string().uuid().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  freezeMinutes: z.number().int().min(0).max(600).default(60),
  penaltySecondsPerReject: z.number().int().min(0).max(86_400).default(1_200),
  virtualAllowed: z.boolean().default(true),
});

const createProblemSchema = z.object({
  label: z.string().regex(/^[A-Z]$/),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,126}$/),
  title: z.string().trim().min(3).max(200),
  statement: z.string().min(1).max(200_000),
  points: z.number().int().min(1).max(10_000),
  timeLimitMs: z.number().int().min(100).max(60_000).default(2_000),
  memoryMb: z.number().int().min(64).max(8_192).default(512),
  maxQubits: z.number().int().min(1).max(40).default(20),
  graderKey: z.string().min(1).max(128),
  lessonId: z.number().int().positive().optional(),
  opensAt: z.coerce.date().optional(),
  position: z.number().int().min(1).max(100),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const { db, env, redis, queues, entitlements: entitlementService, sessions } = app.services;
  const degradation = createDegradationController(env, redis.client);

  useIdempotency(app);
  const readLimit = rateLimit(app, 'read');
  const writeLimit = rateLimit(app, 'write');

  app.addHook('preHandler', async (request: FastifyRequest) => {
    requireRole(request, 'admin');
  });

  // ------------------------------------------------------------------- users

  app.get('/users', { preHandler: [readLimit] }, async (request, reply) => {
    const query = readQuery(
      request,
      paginationSchema.extend({
        q: z.string().trim().max(320).optional(),
        role: z.enum(['learner', 'instructor', 'org_admin', 'admin']).optional(),
        status: z.enum(['active', 'suspended', 'deleted']).optional(),
      }),
    );

    const filters = [];
    if (query.q) {
      filters.push(
        sql`(lower(${users.email}) like ${`%${query.q.toLowerCase()}%`} or lower(${users.handle}) like ${`%${query.q.toLowerCase()}%`})`,
      );
    }
    if (query.role) filters.push(eq(users.role, query.role));
    if (query.status) filters.push(eq(users.status, query.status));

    const where = filters.length > 0 ? and(...filters) : undefined;

    const rows = await db.replica
      .select({
        id: users.id,
        email: users.email,
        handle: users.handle,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        mfaEnrolled: users.mfaEnrolled,
        orgId: users.orgId,
        orgName: orgs.name,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .leftJoin(orgs, eq(orgs.id, users.orgId))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.replica
      .select({ total: sql<number>`count(*)::int` })
      .from(users)
      .where(where);

    return reply.send(page(rows, query, counted[0]?.total ?? 0));
  });

  /**
   * Role and status changes bump `privilege_version` and destroy every session
   * the user holds — §8's "rotated on privilege change", applied to the case
   * that matters most: revocation.
   */
  app.patch('/users/:userId', { preHandler: [writeLimit] }, async (request, reply) => {
    const { userId } = readParams(request, z.object({ userId: z.string().uuid() }));
    const input = readBody(
      request,
      z.object({
        role: z.enum(['learner', 'instructor', 'org_admin', 'admin']).optional(),
        status: z.enum(['active', 'suspended', 'deleted']).optional(),
        orgId: z.string().uuid().nullable().optional(),
      }),
    );

    if (input.role === undefined && input.status === undefined && input.orgId === undefined) {
      throw new ApiError('validation-failed', 'Provide at least one field to change.');
    }

    const updated = await db.primary
      .update(users)
      .set({
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
        privilegeVersion: sql`${users.privilegeVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        role: users.role,
        status: users.status,
        privilegeVersion: users.privilegeVersion,
      });

    const row = updated[0];
    if (!row) throw problem.notFound('User');

    const revoked = await sessions.destroyAllForUser(userId, 'privilege_change');
    await entitlementService.recompute(userId);

    return reply.send({ user: row, sessionsRevoked: revoked });
  });

  // --------------------------------------------------------------- contests

  app.post('/contests', { preHandler: [writeLimit] }, async (request, reply) => {
    const input = readBody(request, createContestSchema);

    if (input.endsAt <= input.startsAt) {
      throw new ApiError('validation-failed', 'endsAt must be after startsAt.');
    }
    const windowMinutes = (input.endsAt.getTime() - input.startsAt.getTime()) / 60_000;
    if (input.freezeMinutes >= windowMinutes) {
      throw new ApiError('validation-failed', 'The freeze must fall inside the contest window.');
    }
    if (input.kind === 'private' && !input.orgId) {
      throw new ApiError('validation-failed', 'A private contest needs an organisation.');
    }

    const inserted = await db.primary
      .insert(contests)
      .values({
        slug: input.slug,
        title: input.title,
        description: input.description ?? null,
        kind: input.kind,
        status: 'scheduled',
        orgId: input.orgId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        freezeMinutes: input.freezeMinutes,
        penaltySecondsPerReject: input.penaltySecondsPerReject,
        virtualAllowed: input.virtualAllowed,
      })
      .onConflictDoNothing({ target: contests.slug })
      .returning({ id: contests.id });

    const contest = inserted[0];
    if (!contest) throw new ApiError('conflict', 'A contest with that slug already exists.');

    // §6: the freeze and the finaliser are scheduled the moment the contest is
    // created, so neither depends on anyone remembering to run them.
    const freezeAt = new Date(input.endsAt.getTime() - input.freezeMinutes * 60_000);
    await queues.scheduleContestFreeze(contest.id, freezeAt);
    await queues.scheduleContestFinalise(contest.id, input.endsAt);

    return reply.status(201).send({
      id: contest.id,
      freezeAt: freezeAt.toISOString(),
      finaliseAt: input.endsAt.toISOString(),
    });
  });

  app.patch('/contests/:contestId', { preHandler: [writeLimit] }, async (request, reply) => {
    const { contestId } = readParams(request, z.object({ contestId: z.string().uuid() }));
    const input = readBody(
      request,
      z.object({
        status: z
          .enum(['draft', 'scheduled', 'running', 'frozen', 'finalising', 'finalised', 'cancelled'])
          .optional(),
        title: z.string().trim().min(3).max(200).optional(),
        description: z.string().max(20_000).optional(),
      }),
    );

    const updated = await db.primary
      .update(contests)
      .set({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        updatedAt: new Date(),
      })
      .where(eq(contests.id, contestId))
      .returning({ id: contests.id, status: contests.status });

    const row = updated[0];
    if (!row) throw problem.notFound('Contest');
    return reply.send({ contest: row });
  });

  app.post('/contests/:contestId/problems', { preHandler: [writeLimit] }, async (request, reply) => {
    const { contestId } = readParams(request, z.object({ contestId: z.string().uuid() }));
    const input = readBody(request, createProblemSchema);

    const exists = await db.primary
      .select({ id: contests.id })
      .from(contests)
      .where(eq(contests.id, contestId))
      .limit(1);
    if (exists.length === 0) throw problem.notFound('Contest');

    const inserted = await db.primary
      .insert(problems)
      .values({
        contestId,
        label: input.label,
        slug: input.slug,
        title: input.title,
        statement: input.statement,
        points: input.points,
        timeLimitMs: input.timeLimitMs,
        memoryMb: input.memoryMb,
        maxQubits: input.maxQubits,
        graderKey: input.graderKey,
        lessonId: input.lessonId ?? null,
        opensAt: input.opensAt ?? null,
        position: input.position,
      })
      .onConflictDoNothing()
      .returning({ id: problems.id });

    const created = inserted[0];
    if (!created) {
      throw new ApiError('conflict', 'A problem with that label, slug or position already exists.');
    }

    return reply.status(201).send({ id: created.id });
  });

  // ---------------------------------------------------- degradation ladder

  app.get('/degradation', { preHandler: [readLimit] }, async (_request, reply) => {
    return reply.send(await degradation.get());
  });

  app.put('/degradation', { preHandler: [writeLimit] }, async (request, reply) => {
    const input = readBody(request, degradationSchema.partial());
    const next = await degradation.set(input);
    request.log.warn({ degradation: next }, 'degradation ladder changed');
    return reply.send(next);
  });

  app.delete('/degradation', { preHandler: [writeLimit] }, async (request, reply) => {
    const next = await degradation.clear();
    request.log.warn('degradation ladder reset to environment defaults');
    return reply.send(next);
  });

  // ------------------------------------------------------------- operations

  app.get('/queues', { preHandler: [readLimit] }, async (_request, reply) => {
    return reply.send({ depth: await queues.depth() });
  });

  app.post('/queues/repeatables', { preHandler: [writeLimit] }, async (_request, reply) => {
    await queues.installRepeatables();
    return reply.send({ installed: true });
  });

  app.get('/stripe-events', { preHandler: [readLimit] }, async (request, reply) => {
    const query = readQuery(
      request,
      paginationSchema.extend({
        status: z.enum(['received', 'processed', 'failed', 'ignored']).optional(),
      }),
    );

    const where = query.status ? eq(stripeEvents.status, query.status) : undefined;

    const rows = await db.replica
      .select({
        id: stripeEvents.id,
        stripeEventId: stripeEvents.stripeEventId,
        type: stripeEvents.type,
        status: stripeEvents.status,
        error: stripeEvents.error,
        attempts: stripeEvents.attempts,
        receivedAt: stripeEvents.receivedAt,
        processedAt: stripeEvents.processedAt,
      })
      .from(stripeEvents)
      .where(where)
      .orderBy(desc(stripeEvents.receivedAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.replica
      .select({ total: sql<number>`count(*)::int` })
      .from(stripeEvents)
      .where(where);

    return reply.send(page(rows, query, counted[0]?.total ?? 0));
  });

  app.get('/reconciliation', { preHandler: [readLimit] }, async (request, reply) => {
    const query = readQuery(request, paginationSchema);
    const rows = await db.replica
      .select()
      .from(reconciliationRuns)
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(query.limit)
      .offset(query.offset);
    return reply.send({ items: rows });
  });

  // ------------------------------------------------------------- moderation

  app.get('/reports', { preHandler: [readLimit] }, async (request, reply) => {
    const query = readQuery(
      request,
      paginationSchema.extend({
        status: z.enum(['open', 'reviewing', 'upheld', 'dismissed']).default('open'),
      }),
    );

    const rows = await db.replica
      .select({
        id: reports.id,
        reporterId: reports.reporterId,
        targetType: reports.targetType,
        targetId: reports.targetId,
        reason: reports.reason,
        detail: reports.detail,
        status: reports.status,
        createdAt: reports.createdAt,
      })
      .from(reports)
      .where(eq(reports.status, query.status))
      .orderBy(desc(reports.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.replica
      .select({ total: sql<number>`count(*)::int` })
      .from(reports)
      .where(eq(reports.status, query.status));

    return reply.send(page(rows, query, counted[0]?.total ?? 0));
  });

  app.patch('/reports/:reportId', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = requireRole(request, 'admin');
    const { reportId } = readParams(request, z.object({ reportId: z.string().uuid() }));
    const input = readBody(
      request,
      z.object({
        status: z.enum(['reviewing', 'upheld', 'dismissed']),
        /** Upholding a report can take the content down in the same call. */
        removeTarget: z.boolean().default(false),
      }),
    );

    const rows = await db.primary
      .select({ id: reports.id, targetType: reports.targetType, targetId: reports.targetId })
      .from(reports)
      .where(eq(reports.id, reportId))
      .limit(1);

    const report = rows[0];
    if (!report) throw problem.notFound('Report');

    await db.primary
      .update(reports)
      .set({
        status: input.status,
        resolvedBy: auth.userId,
        resolvedAt: input.status === 'reviewing' ? null : new Date(),
      })
      .where(eq(reports.id, reportId));

    if (input.removeTarget && input.status === 'upheld') {
      const now = new Date();
      if (report.targetType === 'discussion') {
        await db.primary
          .update(discussions)
          .set({ deletedAt: now })
          .where(eq(discussions.id, report.targetId));
      } else {
        await db.primary
          .update(comments)
          .set({ deletedAt: now })
          .where(eq(comments.id, report.targetId));
      }
    }

    return reply.send({ updated: true });
  });
};

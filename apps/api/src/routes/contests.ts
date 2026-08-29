/**
 * Contests (system-design §6) — "the hardest correctness problem in the product".
 *
 * The submit path is deliberately thin: validate, insert one row into a
 * partitioned table, enqueue at contest priority, return 202. §6 budgets 12 ms
 * for it, which is only achievable if nothing on this path takes a lock or waits
 * on a grader.
 *
 * Scoring happens on the verdict callback and goes through the Redis Lua script
 * in `src/contest/scoring.ts`, which is what makes the board monotone and makes
 * at-least-once delivery from BullMQ safe.
 */
import { and, asc, desc, eq, gte, inArray, ne, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  contests,
  problems,
  registrations,
  submissions as contestSubmissions,
} from '../db/schema/contest.js';
import { users } from '../db/schema/identity.js';
import {
  finaliseContest,
  freezeContest,
  readSnapshot,
  type ContestRow,
} from '../contest/finaliser.js';
import {
  applyAccepted,
  applyRejected,
  freezeAt,
  isFrozen,
  isRunning,
  keyTtlSeconds,
  publishDelta,
  readStandings,
  type ScoringDeps,
} from '../contest/scoring.js';
import { assertFeature } from '../entitlements/index.js';
import { ApiError, problem } from '../errors.js';
import { normalisedSourceHash, randomUUID } from '../lib/crypto.js';
import { keys } from '../redis/scripts.js';
import { CONTEST_PROBLEM_COOLDOWN_SECONDS } from '../middleware/rate-limit.js';
import { awardXp, bumpXpLeaderboards } from '../progress/service.js';
import {
  assertWritesEnabled,
  authed,
  page,
  paginationSchema,
  rateLimit,
  readBody,
  readParams,
  readQuery,
  requireServiceToken,
  useIdempotency,
} from './helpers.js';
import { createDegradationController } from '../lib/degradation.js';

const contestRefSchema = z.object({
  contest: z.string().min(1).max(128),
});

const submitSchema = z.object({
  problemId: z.string().uuid(),
  language: z.enum(['qiskit', 'cirq', 'pennylane', 'openqasm', 'python']),
  source: z.string().min(1).max(262_144),
});

const verdictSchema = z.object({
  submissionId: z.string().uuid(),
  verdict: z.enum([
    'accepted',
    'wrong_answer',
    'runtime_error',
    'time_limit',
    'memory_limit',
    'compile_error',
    'resource_limit',
    'rejected_duplicate',
  ]),
  runtimeMs: z.number().int().min(0).max(600_000).optional(),
});

/** §6 anti-cheat: a submission within 4 s of a problem opening is impossible. */
const IMPOSSIBLY_FAST_SECONDS = 4;

/** A contest row carrying the owning organisation, which visibility needs. */
type VisibleContest = ContestRow & { orgId: string | null };

export const contestRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis, scripts, metrics, queues, limiter, env } = app.services;
  const degradation = createDegradationController(env, redis.client);

  const scoring: ScoringDeps = {
    redis: redis.client,
    scripts,
    metrics,
    publisher: redis.publisher,
  };

  useIdempotency(app);
  const readLimit = rateLimit(app, 'read');
  const writeLimit = rateLimit(app, 'write');
  const submitLimit = rateLimit(app, 'contest_submission');

  async function loadContest(ref: string): Promise<VisibleContest> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const rows = await db.primary
      .select({
        id: contests.id,
        slug: contests.slug,
        kind: contests.kind,
        orgId: contests.orgId,
        status: contests.status,
        startsAt: contests.startsAt,
        endsAt: contests.endsAt,
        freezeMinutes: contests.freezeMinutes,
        penaltySecondsPerReject: contests.penaltySecondsPerReject,
      })
      .from(contests)
      .where(isUuid ? eq(contests.id, ref) : eq(contests.slug, ref))
      .limit(1);

    const row = rows[0];
    if (!row) throw problem.notFound('Contest');
    return row as VisibleContest;
  }

  /**
   * §7 makes a private contest an organisation's own event, and the listing
   * above already hides one from everybody else. Fetching by slug or id has to
   * apply the same rule, or the listing filter is decoration: without this a
   * learner in any organisation could read a rival's problem set (and, once the
   * contest ended, its whole statement text) by naming the slug.
   */
  function assertContestVisible(request: FastifyRequest, contest: VisibleContest): void {
    if (contest.kind !== 'private') return;
    const auth = request.auth;
    if (!auth) throw problem.unauthorized();
    if (auth.role === 'admin') return;
    if (!contest.orgId || auth.orgId !== contest.orgId) {
      throw problem.forbidden('This contest is private to another organisation.');
    }
  }

  async function loadRegistration(contestId: string, userId: string) {
    const rows = await db.primary
      .select({
        kind: registrations.kind,
        virtualStartAt: registrations.virtualStartAt,
        rated: registrations.rated,
        registeredAt: registrations.registeredAt,
      })
      .from(registrations)
      .where(and(eq(registrations.contestId, contestId), eq(registrations.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Elapsed seconds for the leaderboard tiebreak. A virtual participant runs the
   * contest on their own clock, which is exactly why they are never rated: their
   * elapsed time is not comparable with anyone else's.
   */
  function elapsedSeconds(
    contest: ContestRow,
    registration: { kind: string; virtualStartAt: Date | null },
    now: Date,
  ): number {
    const origin =
      registration.kind === 'virtual' && registration.virtualStartAt
        ? registration.virtualStartAt
        : contest.startsAt;
    return Math.max(0, Math.floor((now.getTime() - origin.getTime()) / 1000));
  }

  function virtualWindowOpen(
    contest: ContestRow,
    registration: { kind: string; virtualStartAt: Date | null },
    now: Date,
  ): boolean {
    if (registration.kind !== 'virtual' || !registration.virtualStartAt) return false;
    const duration = contest.endsAt.getTime() - contest.startsAt.getTime();
    return now.getTime() < registration.virtualStartAt.getTime() + duration;
  }

  // ------------------------------------------------------------------- lists

  app.get('/', { preHandler: [readLimit] }, async (request, reply) => {
    const query = readQuery(
      request,
      paginationSchema.extend({
        state: z.enum(['all', 'upcoming', 'running', 'past']).default('all'),
      }),
    );

    const now = new Date();
    const visibility = request.auth?.orgId
      ? or(ne(contests.kind, 'private'), eq(contests.orgId, request.auth.orgId))
      : ne(contests.kind, 'private');

    const filters = [ne(contests.status, 'draft'), visibility];
    if (query.state === 'upcoming') filters.push(sql`${contests.startsAt} > ${now}`);
    if (query.state === 'running') {
      filters.push(sql`${contests.startsAt} <= ${now} and ${contests.endsAt} > ${now}`);
    }
    if (query.state === 'past') filters.push(sql`${contests.endsAt} <= ${now}`);

    const rows = await db.read(request.readFromPrimary)
      .select({
        id: contests.id,
        slug: contests.slug,
        title: contests.title,
        description: contests.description,
        kind: contests.kind,
        status: contests.status,
        startsAt: contests.startsAt,
        endsAt: contests.endsAt,
        freezeMinutes: contests.freezeMinutes,
        virtualAllowed: contests.virtualAllowed,
        ratingFloor: contests.ratingFloor,
      })
      .from(contests)
      .where(and(...filters))
      .orderBy(desc(contests.startsAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.read(request.readFromPrimary)
      .select({ total: sql<number>`count(*)::int` })
      .from(contests)
      .where(and(...filters));

    return reply.send(
      page(
        rows.map((row) => ({
          ...row,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          freezeAt: freezeAt(row).toISOString(),
        })),
        query,
        counted[0]?.total ?? 0,
      ),
    );
  });

  app.get('/:contest', { preHandler: [readLimit] }, async (request, reply) => {
    const { contest: ref } = readParams(request, contestRefSchema);
    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const now = new Date();

    const registration = request.auth
      ? await loadRegistration(contest.id, request.auth.userId)
      : null;

    const problemCount = await db.read(request.readFromPrimary)
      .select({ total: sql<number>`count(*)::int` })
      .from(problems)
      .where(eq(problems.contestId, contest.id));

    return reply.send({
      contest: {
        id: contest.id,
        slug: contest.slug,
        kind: contest.kind,
        status: contest.status,
        startsAt: contest.startsAt.toISOString(),
        endsAt: contest.endsAt.toISOString(),
        freezeAt: freezeAt(contest).toISOString(),
        freezeMinutes: contest.freezeMinutes,
        penaltySecondsPerReject: contest.penaltySecondsPerReject,
        problemCount: problemCount[0]?.total ?? 0,
      },
      clock: {
        now: now.toISOString(),
        running: isRunning(contest, now),
        frozen: isFrozen(contest, now),
        secondsToStart: Math.max(
          0,
          Math.floor((contest.startsAt.getTime() - now.getTime()) / 1000),
        ),
        secondsToEnd: Math.max(0, Math.floor((contest.endsAt.getTime() - now.getTime()) / 1000)),
      },
      registration: registration
        ? {
            kind: registration.kind,
            rated: registration.rated,
            virtualStartAt: registration.virtualStartAt?.toISOString() ?? null,
            registeredAt: registration.registeredAt.toISOString(),
          }
        : null,
    });
  });

  // ------------------------------------------------------------- registration

  app.post('/:contest/register', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { contest: ref } = readParams(request, contestRefSchema);
    const input = readBody(
      request,
      z.object({ rated: z.boolean().default(true) }),
    );

    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const entitlements = request.entitlements ?? auth.entitlements;

    if (contest.kind === 'private') assertFeature(entitlements, 'contests.private');
    if (contest.status === 'cancelled') {
      throw new ApiError('contest-closed', 'This contest was cancelled.');
    }
    if (new Date() >= contest.endsAt) {
      throw new ApiError('contest-closed', 'This contest has ended; register for virtual instead.');
    }

    // §7: rated participation is a Pro feature. A Free learner can still take
    // part, unrated, which is what "Contests: participate" means.
    const rated = input.rated && contest.kind === 'rated' && entitlements.contests.rated;

    await db.primary
      .insert(registrations)
      .values({ contestId: contest.id, userId: auth.userId, kind: 'live', rated })
      .onConflictDoUpdate({
        target: [registrations.contestId, registrations.userId],
        set: { rated },
      });

    return reply.status(201).send({
      registered: true,
      rated,
      ratedAvailable: entitlements.contests.rated,
    });
  });

  /**
   * Virtual participation: the contest replayed on the participant's own clock.
   * Always unrated — the schema enforces it too — because an elapsed time
   * measured against a private start is not comparable with the live field.
   */
  app.post('/:contest/virtual', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { contest: ref } = readParams(request, contestRefSchema);
    const input = readBody(
      request,
      z.object({ startAt: z.coerce.date().optional() }),
    );

    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const now = new Date();

    const virtualAllowed = await db.primary
      .select({ allowed: contests.virtualAllowed })
      .from(contests)
      .where(eq(contests.id, contest.id))
      .limit(1);

    if (!virtualAllowed[0]?.allowed) {
      throw new ApiError('conflict', 'This contest does not allow virtual participation.');
    }
    if (now < contest.endsAt) {
      throw new ApiError(
        'conflict',
        'Virtual participation opens once the live contest has finished.',
      );
    }

    const startAt = input.startAt ?? now;
    if (startAt.getTime() < now.getTime() - 60_000) {
      throw new ApiError('validation-failed', 'A virtual start cannot be in the past.');
    }

    const existing = await loadRegistration(contest.id, auth.userId);
    if (existing?.kind === 'live') {
      throw new ApiError(
        'conflict',
        'You took part in the live contest and cannot also run it virtually.',
      );
    }

    await db.primary
      .insert(registrations)
      .values({
        contestId: contest.id,
        userId: auth.userId,
        kind: 'virtual',
        virtualStartAt: startAt,
        rated: false,
      })
      .onConflictDoUpdate({
        target: [registrations.contestId, registrations.userId],
        set: { kind: 'virtual', virtualStartAt: startAt, rated: false },
      });

    const durationSeconds = Math.floor(
      (contest.endsAt.getTime() - contest.startsAt.getTime()) / 1000,
    );

    return reply.status(201).send({
      kind: 'virtual',
      startAt: startAt.toISOString(),
      endsAt: new Date(startAt.getTime() + durationSeconds * 1000).toISOString(),
      durationSeconds,
      rated: false,
    });
  });

  // ---------------------------------------------------------------- problems

  app.get('/:contest/problems', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { contest: ref } = readParams(request, contestRefSchema);
    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const now = new Date();

    const registration = await loadRegistration(contest.id, auth.userId);
    const open =
      now >= contest.endsAt ||
      (registration !== null &&
        (isRunning(contest, now) || virtualWindowOpen(contest, registration, now)));

    if (!open) {
      throw new ApiError('contest-closed', 'The problem set is not open for you yet.', {
        extensions: {
          startsAt: contest.startsAt.toISOString(),
          registered: registration !== null,
        },
      });
    }

    const rows = await db.read(request.readFromPrimary)
      .select({
        id: problems.id,
        label: problems.label,
        slug: problems.slug,
        title: problems.title,
        points: problems.points,
        timeLimitMs: problems.timeLimitMs,
        memoryMb: problems.memoryMb,
        maxQubits: problems.maxQubits,
        position: problems.position,
      })
      .from(problems)
      .where(eq(problems.contestId, contest.id))
      .orderBy(asc(problems.position));

    const solved = await redis.client.hgetall(keys.solveDetail(contest.id, auth.userId));

    return reply.send({
      items: rows.map((row) => ({
        ...row,
        solved: Object.prototype.hasOwnProperty.call(solved, row.id),
      })),
    });
  });

  app.get('/:contest/problems/:label', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { contest: ref, label } = readParams(
      request,
      contestRefSchema.extend({ label: z.string().regex(/^[A-Z]$/) }),
    );

    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const now = new Date();
    const registration = await loadRegistration(contest.id, auth.userId);
    const open =
      now >= contest.endsAt ||
      (registration !== null &&
        (isRunning(contest, now) || virtualWindowOpen(contest, registration, now)));

    if (!open) throw new ApiError('contest-closed', 'This problem is not open for you yet.');

    // Explicit columns rather than `select()`: the row also carries
    // `grader_key`, which names the sandbox image that holds the hidden tests
    // and is not something a competitor should be handed.
    const rows = await db.read(request.readFromPrimary)
      .select({
        id: problems.id,
        contestId: problems.contestId,
        label: problems.label,
        slug: problems.slug,
        title: problems.title,
        statement: problems.statement,
        points: problems.points,
        timeLimitMs: problems.timeLimitMs,
        memoryMb: problems.memoryMb,
        maxQubits: problems.maxQubits,
        lessonId: problems.lessonId,
        opensAt: problems.opensAt,
        position: problems.position,
      })
      .from(problems)
      .where(and(eq(problems.contestId, contest.id), eq(problems.label, label)))
      .limit(1);

    const found = rows[0];
    if (!found) throw problem.notFound('Problem');

    return reply.send({ problem: found });
  });

  // ------------------------------------------------------------------ submit

  app.post('/:contest/submit', { preHandler: [submitLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { contest: ref } = readParams(request, contestRefSchema);
    const input = readBody(request, submitSchema);

    const state = await degradation.get();
    assertWritesEnabled(state.writesDisabled);

    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const now = new Date();

    const registration = await loadRegistration(contest.id, auth.userId);
    if (!registration) {
      throw new ApiError('forbidden', 'Register for the contest before submitting.');
    }

    const live = registration.kind === 'live' && isRunning(contest, now);
    const virtual = virtualWindowOpen(contest, registration, now);
    if (!live && !virtual) {
      throw new ApiError('contest-closed', 'The submission window is closed.', {
        extensions: { kind: registration.kind, endsAt: contest.endsAt.toISOString() },
      });
    }

    const problemRows = await db.primary
      .select({
        id: problems.id,
        label: problems.label,
        points: problems.points,
        graderKey: problems.graderKey,
        opensAt: problems.opensAt,
      })
      .from(problems)
      .where(and(eq(problems.id, input.problemId), eq(problems.contestId, contest.id)))
      .limit(1);

    const target = problemRows[0];
    if (!target) throw problem.notFound('Problem');

    // §9: 10 submissions/min (the bucket above) *plus* a 20 s per-problem
    // cooldown, which is what stops a brute-force sweep of one problem.
    const cooldown = await limiter.contestCooldownRemaining(
      contest.id,
      auth.userId,
      target.id,
    );
    if (cooldown > 0) {
      throw new ApiError(
        'contest-cooldown',
        `Wait ${cooldown}s before submitting to problem ${target.label} again.`,
        { retryAfterSeconds: cooldown, extensions: { problemLabel: target.label } },
      );
    }

    const elapsed = elapsedSeconds(contest, registration, now);
    const sourceHash = normalisedSourceHash(input.source);

    // §6 anti-cheat, evaluated at write time because it is cheap here and
    // expensive later: exact duplicate across users, and impossibly fast solves.
    const duplicates = await db.primary
      .select({ userId: contestSubmissions.userId })
      .from(contestSubmissions)
      .where(
        and(
          eq(contestSubmissions.contestId, contest.id),
          eq(contestSubmissions.sourceHash, sourceHash),
          ne(contestSubmissions.userId, auth.userId),
        ),
      )
      .limit(1);

    const openedAt = target.opensAt ?? contest.startsAt;
    const tooFast = now.getTime() - openedAt.getTime() < IMPOSSIBLY_FAST_SECONDS * 1000;

    const flagged = duplicates.length > 0 || tooFast;
    const flagReason = duplicates.length > 0 ? 'duplicate_source' : tooFast ? 'impossibly_fast' : null;

    const submissionId = randomUUID();
    const createdAt = now;

    const jobId = await db.primary.transaction(async (tx) => {
      await tx.insert(contestSubmissions).values({
        id: submissionId,
        contestId: contest.id,
        userId: auth.userId,
        problemId: target.id,
        language: input.language,
        source: input.source,
        sourceHash,
        verdict: 'pending',
        score: 0,
        elapsedSeconds: elapsed,
        isVirtual: registration.kind === 'virtual',
        flagged,
        flagReason,
        idempotencyKey: request.idempotency?.key ?? null,
        jobId: submissionId,
        createdAt,
      });

      return queues.enqueueContest(
        {
          kind: 'contest',
          submissionId,
          submissionCreatedAt: createdAt.toISOString(),
          userId: auth.userId,
          contestId: contest.id,
          problemId: target.id,
          graderKey: target.graderKey,
          language: input.language,
          source: input.source,
          points: target.points,
          elapsedSeconds: elapsed,
          penaltySecondsPerReject: contest.penaltySecondsPerReject,
          isVirtual: registration.kind === 'virtual',
          keyTtlSeconds: keyTtlSeconds(contest, now),
        },
        submissionId,
      );
    });

    await limiter.markContestCooldown(contest.id, auth.userId, target.id);

    return reply.status(202).send({
      submissionId,
      jobId,
      verdict: 'pending',
      elapsedSeconds: elapsed,
      flagged,
      cooldownSeconds: CONTEST_PROBLEM_COOLDOWN_SECONDS,
      pollAfterMs: 1_000,
    });
  });

  app.get('/:contest/submissions', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { contest: ref } = readParams(request, contestRefSchema);
    const query = readQuery(request, paginationSchema);
    const contest = await loadContest(ref);
    assertContestVisible(request, contest);

    const filters = [
      eq(contestSubmissions.contestId, contest.id),
      eq(contestSubmissions.userId, auth.userId),
    ];

    const rows = await db.read(request.readFromPrimary)
      .select({
        id: contestSubmissions.id,
        problemId: contestSubmissions.problemId,
        problemLabel: problems.label,
        language: contestSubmissions.language,
        verdict: contestSubmissions.verdict,
        score: contestSubmissions.score,
        elapsedSeconds: contestSubmissions.elapsedSeconds,
        flagged: contestSubmissions.flagged,
        createdAt: contestSubmissions.createdAt,
        judgedAt: contestSubmissions.judgedAt,
      })
      .from(contestSubmissions)
      .innerJoin(problems, eq(problems.id, contestSubmissions.problemId))
      .where(and(...filters))
      .orderBy(desc(contestSubmissions.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.read(request.readFromPrimary)
      .select({ total: sql<number>`count(*)::int` })
      .from(contestSubmissions)
      .where(and(...filters));

    return reply.send(
      page(
        rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          judgedAt: row.judgedAt?.toISOString() ?? null,
        })),
        query,
        counted[0]?.total ?? 0,
      ),
    );
  });

  // -------------------------------------------------------------- standings

  app.get('/:contest/standings', { preHandler: [readLimit] }, async (request, reply) => {
    const { contest: ref } = readParams(request, contestRefSchema);
    const query = readQuery(
      request,
      paginationSchema.extend({
        /** Admins can look behind the freeze; nobody else can. */
        live: z
          .enum(['true', 'false'])
          .default('false')
          .transform((value) => value === 'true'),
      }),
    );

    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const now = new Date();
    const frozen = isFrozen(contest, now);
    const wantsLive = query.live && request.auth?.role === 'admin';

    // After the freeze the public board is the frozen snapshot; the ZSET keeps
    // updating underneath and the finaliser publishes the truth at T+0 (§6).
    if (frozen && !wantsLive) {
      const snapshot = await readSnapshot(db, contest.id, 'freeze', query);
      if (snapshot) {
        return reply.send({
          frozen: true,
          source: 'snapshot',
          takenAt: snapshot.takenAt.toISOString(),
          ...page(snapshot.entries, query, snapshot.total),
        });
      }
    }

    if (contest.status === 'finalised' && !wantsLive) {
      const snapshot = await readSnapshot(db, contest.id, 'final', query);
      if (snapshot) {
        return reply.send({
          frozen: false,
          final: true,
          source: 'snapshot',
          takenAt: snapshot.takenAt.toISOString(),
          ...page(snapshot.entries, query, snapshot.total),
        });
      }
    }

    const board = await readStandings(redis.client, contest.id, {
      limit: query.limit,
      offset: query.offset,
      withDetail: true,
    });

    const handles =
      board.entries.length === 0
        ? []
        : await db.read(request.readFromPrimary)
            .select({ id: users.id, handle: users.handle, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, board.entries.map((entry) => entry.userId)));

    const byId = new Map(handles.map((row) => [row.id, row]));

    return reply.send({
      frozen,
      final: contest.status === 'finalised',
      source: 'live',
      ...page(
        board.entries.map((entry) => ({
          ...entry,
          handle: byId.get(entry.userId)?.handle ?? null,
          displayName: byId.get(entry.userId)?.displayName ?? null,
        })),
        query,
        board.total,
      ),
    });
  });

  // ------------------------------------------------- freeze and finalisation

  /**
   * Both operations are exposed so an operator can run them by hand — the
   * scheduled BullMQ jobs call the same functions. They are idempotent, so a
   * duplicate click is harmless.
   */
  app.post('/:contest/freeze', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    if (auth.role !== 'admin') throw problem.forbidden('Only an admin can freeze a contest.');
    const { contest: ref } = readParams(request, contestRefSchema);
    const contest = await loadContest(ref);
    assertContestVisible(request, contest);
    const result = await freezeContest(db, scoring, contest);
    return reply.send(result);
  });

  app.post('/:contest/finalise', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    if (auth.role !== 'admin') throw problem.forbidden('Only an admin can finalise a contest.');
    const { contest: ref } = readParams(request, contestRefSchema);
    const contest = await loadContest(ref);
    assertContestVisible(request, contest);

    if (new Date() < contest.endsAt) {
      throw new ApiError('conflict', 'A contest cannot be finalised before it ends.');
    }

    const result = await finaliseContest(db, scoring, contest);
    return reply.send({
      snapshotId: result.snapshotId,
      participantCount: result.participantCount,
      ratedCount: result.ratedCount,
      alreadyFinalised: result.alreadyFinalised,
      ratingChanges: result.ratingChanges.slice(0, 100),
    });
  });

  // ------------------------------------------------------- grader callback

  /**
   * The scoring entry point (§6 step 3). Called by a grader worker with an
   * internal service token once a submission has been executed in the sandbox.
   *
   * Everything correctness-critical happens in `applyAccepted`, which is one
   * `EVALSHA` of the SETNX+ZINCRBY script. This handler is only allowed to be
   * *slow*, never wrong: it may be delivered twice, out of order, or after the
   * contest has ended, and none of those change the board.
   */
  app.post('/:contest/verdict', async (request, reply) => {
    requireServiceToken(request, 'contest:verdict');
    const { contest: ref } = readParams(request, contestRefSchema);
    const input = readBody(request, verdictSchema);

    // No visibility guard here on purpose: this is the grader callback, and the
    // caller is a service token, not a member of the contest's organisation.
    const contest = await loadContest(ref);
    const now = new Date();

    const rows = await db.primary
      .select({
        id: contestSubmissions.id,
        userId: contestSubmissions.userId,
        problemId: contestSubmissions.problemId,
        elapsedSeconds: contestSubmissions.elapsedSeconds,
        isVirtual: contestSubmissions.isVirtual,
        flagged: contestSubmissions.flagged,
        verdict: contestSubmissions.verdict,
        createdAt: contestSubmissions.createdAt,
        points: problems.points,
      })
      .from(contestSubmissions)
      .innerJoin(problems, eq(problems.id, contestSubmissions.problemId))
      .where(
        and(
          eq(contestSubmissions.id, input.submissionId),
          eq(contestSubmissions.contestId, contest.id),
        ),
      )
      .limit(1);

    const submission = rows[0];
    if (!submission) throw problem.notFound('Submission');

    const ttl = keyTtlSeconds(contest, now);

    if (input.verdict !== 'accepted') {
      const attempts = await applyRejected(scoring, {
        contestId: contest.id,
        userId: submission.userId,
        problemId: submission.problemId,
        ttlSeconds: ttl,
      });

      await db.primary
        .update(contestSubmissions)
        .set({ verdict: input.verdict, judgedAt: now })
        .where(
          and(
            eq(contestSubmissions.id, submission.id),
            eq(contestSubmissions.createdAt, submission.createdAt),
          ),
        );

      return reply.send({ scored: false, verdict: input.verdict, rejectedAttempts: attempts });
    }

    // A virtual run is scored on its own board key, never the live one, so a
    // person replaying a finished contest cannot move the historical standings.
    const boardContestId = submission.isVirtual ? `${contest.id}:virtual` : contest.id;

    const outcome = await applyAccepted(scoring, {
      contestId: boardContestId,
      userId: submission.userId,
      problemId: submission.problemId,
      points: submission.points,
      elapsedSeconds: submission.elapsedSeconds,
      penaltySecondsPerReject: contest.penaltySecondsPerReject,
      ttlSeconds: ttl,
    });

    await db.primary
      .update(contestSubmissions)
      .set({
        verdict: 'accepted',
        score: outcome.firstAccept ? submission.points : 0,
        judgedAt: now,
      })
      .where(
        and(
          eq(contestSubmissions.id, submission.id),
          eq(contestSubmissions.createdAt, submission.createdAt),
        ),
      );

    let broadcast = false;
    if (outcome.firstAccept && !submission.isVirtual) {
      broadcast = await publishDelta(
        scoring,
        contest,
        {
          contestId: contest.id,
          userId: submission.userId,
          problemId: submission.problemId,
          points: outcome.total.points,
          penaltySeconds: outcome.total.penaltySeconds,
        },
        now,
      );

      // XP for a contest solve is awarded once, on the first accept, and never
      // for a flagged submission.
      if (!submission.flagged) {
        const xp = submission.points;
        await db.primary.transaction(async (tx) => {
          await awardXp(tx, {
            userId: submission.userId,
            amount: xp,
            kind: 'contest',
            refType: 'contest_problem',
            refId: `${contest.id}:${submission.problemId}`,
          });
        });
        await bumpXpLeaderboards(redis.client, submission.userId, null, xp);
      }
    }

    return reply.send({
      scored: outcome.firstAccept,
      duplicate: !outcome.firstAccept,
      points: outcome.total.points,
      penaltySeconds: outcome.total.penaltySeconds,
      penaltyApplied: outcome.penaltyApplied,
      broadcast,
    });
  });

  /** The caller's own solve state, which the frozen board deliberately hides. */
  app.get('/:contest/me', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { contest: ref } = readParams(request, contestRefSchema);
    const contest = await loadContest(ref);
    assertContestVisible(request, contest);

    const registration = await loadRegistration(contest.id, auth.userId);
    const boardId = registration?.kind === 'virtual' ? `${contest.id}:virtual` : contest.id;

    const [detail, score, rank] = await Promise.all([
      redis.client.hgetall(keys.solveDetail(boardId, auth.userId)),
      redis.client.zscore(keys.leaderboard(boardId), auth.userId),
      redis.client.zrevrank(keys.leaderboard(boardId), auth.userId),
    ]);

    const attempts = await db.read(request.readFromPrimary)
      .select({
        problemId: contestSubmissions.problemId,
        total: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${contestSubmissions.verdict} = 'accepted')::int`,
      })
      .from(contestSubmissions)
      .where(
        and(
          eq(contestSubmissions.contestId, contest.id),
          eq(contestSubmissions.userId, auth.userId),
          gte(contestSubmissions.createdAt, contest.startsAt),
        ),
      )
      .groupBy(contestSubmissions.problemId);

    return reply.send({
      registered: registration !== null,
      kind: registration?.kind ?? null,
      rated: registration?.rated ?? false,
      rank: rank === null ? null : rank + 1,
      rawScore: score === null ? 0 : Number(score),
      solved: Object.keys(detail),
      attempts,
    });
  });
};

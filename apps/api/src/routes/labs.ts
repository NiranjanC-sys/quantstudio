/**
 * Lab submissions (system-design §5 "highest write volume", §6 step 1, §7
 * credits, §10 sandbox).
 *
 * The submit path is the one place in the product where a mistake costs money or
 * loses work, so it obeys three rules:
 *
 *  - the credit debit, the submission row and the job enqueue happen in one
 *    transaction (§7: "debits happen in the same transaction as job enqueue, so
 *    a job can never run uncharged");
 *  - the BullMQ job id *is* the submission id, so at-least-once delivery cannot
 *    double-grade;
 *  - the gateway never executes anything. It validates, charges, records and
 *    enqueues, and returns 202 (§3: the gateway never does heavy compute).
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { lessons } from '../db/schema/catalog.js';
import { artefacts, submissionResults, submissions } from '../db/schema/labs.js';
import { BACKEND_MULTIPLIERS, creditCost, currentBalance, debitCredits, grantCredits } from '../entitlements/credits.js';
import { ApiError, problem } from '../errors.js';
import { normalisedSourceHash, randomUUID } from '../lib/crypto.js';
import { createDegradationController, effectiveQubitCap } from '../lib/degradation.js';
import { loadLessonGraph, bumpXpLeaderboards, completeLesson } from '../progress/service.js';
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

const submitSchema = z.object({
  lessonId: z.number().int().positive(),
  language: z.enum(['qiskit', 'cirq', 'pennylane', 'openqasm', 'python']),
  /** §5 caps the column at 256 KiB; rejecting here gives a typed 400 instead. */
  source: z.string().min(1).max(262_144),
  /** Simulation shape, for the §7 credit formula. */
  qubits: z.number().int().min(1).max(64).default(1),
  shots: z.number().int().min(1).max(1_048_576).default(1024),
  backend: z
    .enum(['statevector', 'density_matrix', 'tensor_network', 'stabilizer', 'hardware'])
    .default('statevector'),
});

const submissionIdSchema = z.object({ submissionId: z.string().uuid() });

const resultSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  testsTotal: z.number().int().min(0),
  testsPassed: z.number().int().min(0),
  hiddenTestsTotal: z.number().int().min(0).default(0),
  hiddenTestsPassed: z.number().int().min(0).default(0),
  circuitDepth: z.number().int().min(0).nullable().default(null),
  twoQubitGates: z.number().int().min(0).nullable().default(null),
  resourcePenalty: z.number().min(0).max(1).default(0),
  runtimeMs: z.number().int().min(0),
  peakMemoryKb: z.number().int().min(0).nullable().default(null),
  failureMessage: z.string().max(4_096).nullable().default(null),
  status: z.enum(['passed', 'failed', 'error', 'timeout', 'cancelled']),
  detail: z
    .object({
      cases: z.array(
        z.object({
          name: z.string().max(200),
          passed: z.boolean(),
          message: z.string().max(2_000).optional(),
        }),
      ),
    })
    .default({ cases: [] }),
  artefacts: z
    .array(
      z.object({
        kind: z.enum(['stdout', 'stderr', 'statevector', 'histogram', 'circuit_svg', 'report']),
        storageKey: z.string().min(1).max(512),
        contentType: z.string().min(1).max(128),
        bytes: z.number().int().min(0).max(4_194_304),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .default([]),
});

export const labRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis, env, queues, metrics } = app.services;
  const degradation = createDegradationController(env, redis.client);

  useIdempotency(app);
  const readLimit = rateLimit(app, 'read');
  const submitLimit = rateLimit(app, 'lab_submission');

  /** §7: "Labs / month — 40 on Free, unlimited on every paid plan." */
  async function assertMonthlyLabBudget(userId: string, limit: number | null): Promise<number> {
    if (limit === null) return 0;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const rows = await db.primary
      .select({ used: sql<number>`count(*)::int` })
      .from(submissions)
      .where(and(eq(submissions.userId, userId), gte(submissions.createdAt, monthStart)));

    const used = rows[0]?.used ?? 0;
    if (used >= limit) {
      throw new ApiError(
        'entitlement-required',
        `Your plan includes ${limit} lab submissions per month and you have used ${used}.`,
        { extensions: { feature: 'labs.unlimited', used, limit, requiredPlan: 'pro' } },
      );
    }
    return used;
  }

  app.post('/submit', { preHandler: [submitLimit] }, async (request, reply) => {
    const auth = authed(request);
    const input = readBody(request, submitSchema);
    const entitlements = request.entitlements ?? auth.entitlements;

    const state = await degradation.get();
    assertWritesEnabled(state.writesDisabled);

    const lessonRows = await db.primary
      .select({
        id: lessons.id,
        kind: lessons.kind,
        graderKey: lessons.graderKey,
      })
      .from(lessons)
      .where(eq(lessons.id, input.lessonId))
      .limit(1);

    const lesson = lessonRows[0];
    if (!lesson) throw problem.notFound('Lesson');
    if (!lesson.graderKey) {
      throw new ApiError('validation-failed', 'This lesson has no grader and cannot be submitted to.');
    }

    // §4 memory guard, tightened by any temporary operator cap from §9 step 2.
    const planCap =
      input.backend === 'density_matrix'
        ? entitlements.noisyMaxQubits
        : entitlements.maxQubits;

    if (planCap === null) {
      throw new ApiError(
        'entitlement-required',
        'Noisy (density-matrix) simulation is not included in your plan.',
        { extensions: { feature: 'simulation.noisy', requiredPlan: 'pro' } },
      );
    }

    const cap = effectiveQubitCap(planCap, state);
    if (input.qubits > cap) {
      throw new ApiError(
        'entitlement-required',
        `This submission needs ${input.qubits} qubits; the current ceiling is ${cap}.`,
        {
          extensions: {
            feature: 'simulation.qubits',
            requested: input.qubits,
            planCap,
            effectiveCap: cap,
            notice: state.notice,
          },
        },
      );
    }

    await assertMonthlyLabBudget(auth.userId, entitlements.labsPerMonth);

    const quote = creditCost({
      qubits: input.qubits,
      shots: input.shots,
      backend: input.backend,
    });

    // The submission id is generated here so it can be the BullMQ job id, the
    // credit-ledger idempotency key and the row's primary key at once.
    const submissionId = randomUUID();
    const createdAt = new Date();
    const sourceHash = normalisedSourceHash(input.source);

    const enqueued = await db.primary.transaction(async (tx) => {
      await debitCredits(tx, {
        userId: auth.userId,
        credits: quote.credits,
        reason: 'lab',
        refType: 'submission',
        refId: submissionId,
        idempotencyKey: `lab:${submissionId}`,
      });

      await tx.insert(submissions).values({
        id: submissionId,
        userId: auth.userId,
        lessonId: input.lessonId,
        language: input.language,
        source: input.source,
        sourceHash,
        status: 'queued',
        idempotencyKey: request.idempotency?.key ?? null,
        jobId: submissionId,
        creditsCharged: quote.credits,
        createdAt,
      });

      // Inside the transaction on purpose: if the enqueue throws, the debit and
      // the row roll back together and the learner is not charged for a job that
      // was never queued.
      return queues.enqueueLab(
        {
          kind: 'lab',
          submissionId,
          submissionCreatedAt: createdAt.toISOString(),
          userId: auth.userId,
          lessonId: input.lessonId,
          graderKey: lesson.graderKey as string,
          language: input.language,
          source: input.source,
          creditsCharged: quote.credits,
        },
        submissionId,
      );
    });

    metrics.creditsDebited.inc({ reason: 'lab' }, quote.credits);

    return reply.status(202).send({
      submissionId,
      jobId: enqueued,
      status: 'queued',
      createdAt: createdAt.toISOString(),
      credits: {
        charged: quote.credits,
        rawCost: quote.rawCost,
        backendMultiplier: quote.backendMultiplier,
        balance: await currentBalance(db.primary, auth.userId),
      },
      pollAfterMs: 750,
    });
  });

  /** Poll. Cheap by construction: two indexed reads and no joins across shards. */
  app.get('/submissions/:submissionId', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const { submissionId } = readParams(request, submissionIdSchema);

    const rows = await db.read(request.readFromPrimary)
      .select({
        id: submissions.id,
        userId: submissions.userId,
        lessonId: submissions.lessonId,
        language: submissions.language,
        status: submissions.status,
        creditsCharged: submissions.creditsCharged,
        createdAt: submissions.createdAt,
        startedAt: submissions.startedAt,
        finishedAt: submissions.finishedAt,
      })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);

    const submission = rows[0];
    if (!submission) throw problem.notFound('Submission');
    if (submission.userId !== auth.userId && auth.role !== 'admin') {
      throw problem.forbidden('This submission belongs to another learner.');
    }

    const resultRows = await db.read(request.readFromPrimary)
      .select()
      .from(submissionResults)
      .where(eq(submissionResults.submissionId, submissionId))
      .limit(1);

    const artefactRows = await db.read(request.readFromPrimary)
      .select({
        kind: artefacts.kind,
        storageKey: artefacts.storageKey,
        contentType: artefacts.contentType,
        bytes: artefacts.bytes,
      })
      .from(artefacts)
      .where(eq(artefacts.submissionId, submissionId));

    const terminal = ['passed', 'failed', 'error', 'timeout', 'cancelled'].includes(
      submission.status,
    );

    return reply.send({
      submission: {
        ...submission,
        createdAt: submission.createdAt.toISOString(),
        startedAt: submission.startedAt?.toISOString() ?? null,
        finishedAt: submission.finishedAt?.toISOString() ?? null,
      },
      result: resultRows[0] ?? null,
      artefacts: artefactRows,
      terminal,
      pollAfterMs: terminal ? null : 750,
    });
  });

  app.get('/submissions', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const query = readQuery(
      request,
      paginationSchema.extend({
        lessonId: z.coerce.number().int().positive().optional(),
        status: z
          .enum(['queued', 'running', 'passed', 'failed', 'error', 'timeout', 'cancelled'])
          .optional(),
      }),
    );

    const filters = [eq(submissions.userId, auth.userId)];
    if (query.lessonId !== undefined) filters.push(eq(submissions.lessonId, query.lessonId));
    if (query.status) filters.push(eq(submissions.status, query.status));

    const rows = await db.read(request.readFromPrimary)
      .select({
        id: submissions.id,
        lessonId: submissions.lessonId,
        language: submissions.language,
        status: submissions.status,
        creditsCharged: submissions.creditsCharged,
        createdAt: submissions.createdAt,
        finishedAt: submissions.finishedAt,
        lessonSlug: lessons.slug,
        lessonTitle: lessons.title,
        score: submissionResults.score,
        passed: submissionResults.passed,
      })
      .from(submissions)
      .innerJoin(lessons, eq(lessons.id, submissions.lessonId))
      .leftJoin(submissionResults, eq(submissionResults.submissionId, submissions.id))
      .where(and(...filters))
      .orderBy(desc(submissions.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.read(request.readFromPrimary)
      .select({ total: sql<number>`count(*)::int` })
      .from(submissions)
      .where(and(...filters));

    return reply.send(
      page(
        rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
        })),
        query,
        counted[0]?.total ?? 0,
      ),
    );
  });

  app.get('/credits', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const entitlements = request.entitlements ?? auth.entitlements;
    return reply.send({
      balance: await currentBalance(db.read(request.readFromPrimary), auth.userId),
      monthlyGrant: entitlements.simCreditsPerMonth,
      backendMultipliers: BACKEND_MULTIPLIERS,
      formula: 'ceil(2^(n-16)) * (shots/1024) * backend_multiplier',
    });
  });

  /** Price a job before submitting it, so the UI can warn instead of failing. */
  app.post('/quote', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const input = readBody(
      request,
      submitSchema.pick({ qubits: true, shots: true, backend: true }),
    );
    const quote = creditCost(input);
    return reply.send({
      ...quote,
      balance: await currentBalance(db.read(request.readFromPrimary), auth.userId),
      affordable:
        (await currentBalance(db.read(request.readFromPrimary), auth.userId)) >= quote.credits,
    });
  });

  /**
   * Grader callback. Authenticated with an internal service token (§8), never a
   * user session. Writing the result here rather than from the worker's own
   * database connection keeps lesson completion — XP, mastery, the DAG
   * recompute — in one implementation.
   */
  app.post('/internal/:submissionId/result', async (request, reply) => {
    requireServiceToken(request);
    const { submissionId } = readParams(request, submissionIdSchema);
    const input = readBody(request, resultSchema);

    const rows = await db.primary
      .select({
        id: submissions.id,
        userId: submissions.userId,
        lessonId: submissions.lessonId,
        createdAt: submissions.createdAt,
        creditsCharged: submissions.creditsCharged,
        status: submissions.status,
      })
      .from(submissions)
      .where(eq(submissions.id, submissionId))
      .limit(1);

    const submission = rows[0];
    if (!submission) throw problem.notFound('Submission');

    const now = new Date();

    // Idempotent: `submission_results_submission_key` is unique, so a redelivered
    // result is recorded once and the second call is a no-op.
    const inserted = await db.primary
      .insert(submissionResults)
      .values({
        submissionId,
        submissionCreatedAt: submission.createdAt,
        passed: input.passed,
        score: input.score,
        testsTotal: input.testsTotal,
        testsPassed: input.testsPassed,
        hiddenTestsTotal: input.hiddenTestsTotal,
        hiddenTestsPassed: input.hiddenTestsPassed,
        circuitDepth: input.circuitDepth,
        twoQubitGates: input.twoQubitGates,
        resourcePenalty: input.resourcePenalty,
        runtimeMs: input.runtimeMs,
        peakMemoryKb: input.peakMemoryKb,
        failureMessage: input.failureMessage,
        detail: input.detail,
      })
      .onConflictDoNothing()
      .returning({ id: submissionResults.id });

    if (inserted.length === 0) {
      return reply.status(200).send({ recorded: false, reason: 'already-recorded' });
    }

    await db.primary
      .update(submissions)
      .set({ status: input.status, finishedAt: now })
      .where(and(eq(submissions.id, submissionId), eq(submissions.createdAt, submission.createdAt)));

    if (input.artefacts.length > 0) {
      await db.primary
        .insert(artefacts)
        .values(
          input.artefacts.map((artefact) => ({
            submissionId,
            submissionCreatedAt: submission.createdAt,
            kind: artefact.kind,
            storageKey: artefact.storageKey,
            contentType: artefact.contentType,
            bytes: artefact.bytes,
            sha256: artefact.sha256,
          })),
        )
        .onConflictDoNothing();
    }

    // §7: a job that never ran is refunded. `error` and `timeout` are ours, not
    // the learner's; a genuine `failed` is a wrong answer and stays charged.
    if (
      (input.status === 'error' || input.status === 'timeout') &&
      submission.creditsCharged > 0
    ) {
      await db.primary.transaction(async (tx) => {
        await grantCredits(tx, {
          userId: submission.userId,
          credits: submission.creditsCharged,
          reason: 'refund',
          refType: 'submission',
          refId: submissionId,
          idempotencyKey: `refund:${submissionId}`,
        });
      });
    }

    let completion: Awaited<ReturnType<typeof completeLesson>> | null = null;
    if (input.passed) {
      const graph = await loadLessonGraph(db, redis.client);
      completion = await completeLesson(db, redis.client, graph, {
        userId: submission.userId,
        lessonId: submission.lessonId,
        score: input.score,
        secondsSpent: Math.round(input.runtimeMs / 1000),
      });
      if (completion.xpAwarded > 0) {
        await bumpXpLeaderboards(redis.client, submission.userId, null, completion.xpAwarded);
      }
    }

    return reply.send({ recorded: true, completion });
  });
};

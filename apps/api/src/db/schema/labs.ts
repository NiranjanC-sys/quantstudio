/**
 * `labs` schema — system-design §5 ("highest write volume").
 *
 * `labs.submissions` is range-partitioned monthly. There is deliberately no
 * foreign key from `submission_results` or `artefacts` back to it: Postgres
 * cannot reference a partitioned table's composite key from a child table
 * without duplicating the partition key, so the join key `(submission_id,
 * submission_created_at)` is carried explicitly and integrity is owned by the
 * grader worker, which writes both sides.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const labs = pgSchema('labs');

export const submissionLanguage = labs.enum('submission_language', [
  'qiskit',
  'cirq',
  'pennylane',
  'openqasm',
  'python',
]);
export const submissionStatus = labs.enum('submission_status', [
  'queued',
  'running',
  'passed',
  'failed',
  'error',
  'timeout',
  'cancelled',
]);
export const artefactKind = labs.enum('artefact_kind', [
  'stdout',
  'stderr',
  'statevector',
  'histogram',
  'circuit_svg',
  'report',
]);

export const submissions = labs.table(
  'submissions',
  {
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id').notNull(),
    lessonId: integer('lesson_id').notNull(),
    language: submissionLanguage('language').notNull(),
    source: text('source').notNull(),
    /** sha256 of the normalised AST; also feeds contest duplicate detection (§6). */
    sourceHash: text('source_hash').notNull(),
    status: submissionStatus('status').notNull().default('queued'),
    /** Client-supplied `Idempotency-Key` (§9), scoped per user. */
    idempotencyKey: text('idempotency_key'),
    jobId: text('job_id'),
    creditsCharged: integer('credits_charged').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('submissions_user_created_idx').on(t.userId, t.createdAt),
    index('submissions_lesson_created_idx').on(t.lessonId, t.createdAt),
    index('submissions_status_idx').on(t.status).where(sql`${t.status} in ('queued', 'running')`),
    uniqueIndex('submissions_idempotency_key').on(t.userId, t.idempotencyKey, t.createdAt),
    check('submissions_credits_nonneg', sql`${t.creditsCharged} >= 0`),
    check('submissions_source_size', sql`length(${t.source}) <= 262144`),
  ],
);

export const submissionResults = labs.table(
  'submission_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id').notNull(),
    submissionCreatedAt: timestamp('submission_created_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    passed: boolean('passed').notNull(),
    score: doublePrecision('score').notNull(),
    testsTotal: integer('tests_total').notNull(),
    testsPassed: integer('tests_passed').notNull(),
    hiddenTestsTotal: integer('hidden_tests_total').notNull().default(0),
    hiddenTestsPassed: integer('hidden_tests_passed').notNull().default(0),
    /** Resource bounds: a correct-but-wasteful answer scores lower (syllabus). */
    circuitDepth: integer('circuit_depth'),
    twoQubitGates: integer('two_qubit_gates'),
    resourcePenalty: doublePrecision('resource_penalty').notNull().default(0),
    runtimeMs: integer('runtime_ms').notNull(),
    peakMemoryKb: bigint('peak_memory_kb', { mode: 'number' }),
    failureMessage: text('failure_message'),
    detail: jsonb('detail')
      .$type<{ cases: Array<{ name: string; passed: boolean; message?: string }> }>()
      .notNull()
      .default(sql`'{"cases":[]}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('submission_results_submission_key').on(t.submissionId),
    index('submission_results_created_idx').on(t.createdAt),
    check('submission_results_score_range', sql`${t.score} between 0 and 1`),
    check(
      'submission_results_test_counts',
      sql`${t.testsPassed} between 0 and ${t.testsTotal} and ${t.hiddenTestsPassed} between 0 and ${t.hiddenTestsTotal}`,
    ),
    check('submission_results_runtime_nonneg', sql`${t.runtimeMs} >= 0`),
  ],
);

export const artefacts = labs.table(
  'artefacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id').notNull(),
    submissionCreatedAt: timestamp('submission_created_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    kind: artefactKind('kind').notNull(),
    /** Object-store key (S3/R2, §2). Bodies never live in Postgres. */
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('artefacts_submission_idx').on(t.submissionId),
    uniqueIndex('artefacts_storage_key_key').on(t.storageKey),
    check('artefacts_bytes_bounds', sql`${t.bytes} >= 0 and ${t.bytes} <= 4194304`),
  ],
);

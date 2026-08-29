/**
 * `contest` schema — system-design §5 (bursty) and §6.
 *
 * `contest.submissions` is range-partitioned monthly so the 90-second burst is a
 * pure append into one small partition. Scoring itself never touches Postgres on
 * the hot path: the authoritative live board is the Redis ZSET `lb:{contest_id}`
 * mutated by the Lua script in §6. Postgres holds the submission log (used by
 * the post-contest replay that verifies scoring correctness) and the frozen
 * standings snapshots.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { lessons } from './catalog.js';
import { orgs, users } from './identity.js';

export const contest = pgSchema('contest');

export const contestKind = contest.enum('contest_kind', ['rated', 'unrated', 'private']);
export const contestStatus = contest.enum('contest_status', [
  'draft',
  'scheduled',
  'running',
  'frozen',
  'finalising',
  'finalised',
  'cancelled',
]);
export const registrationKind = contest.enum('registration_kind', ['live', 'virtual']);
export const verdict = contest.enum('verdict', [
  'pending',
  'accepted',
  'wrong_answer',
  'runtime_error',
  'time_limit',
  'memory_limit',
  'compile_error',
  'resource_limit',
  'rejected_duplicate',
]);
export const snapshotKind = contest.enum('snapshot_kind', ['freeze', 'final']);

export const contests = contest.table(
  'contests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    kind: contestKind('kind').notNull().default('rated'),
    status: contestStatus('status').notNull().default('draft'),
    /** Private contests belong to a Teams/Campus org (§7). */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** §6: the public board freezes at T-60min. */
    freezeMinutes: integer('freeze_minutes').notNull().default(60),
    /** ICPC-style penalty added per rejected attempt on a later-solved problem. */
    penaltySecondsPerReject: integer('penalty_seconds_per_reject').notNull().default(1200),
    virtualAllowed: boolean('virtual_allowed').notNull().default(true),
    ratingFloor: integer('rating_floor'),
    finalisedAt: timestamp('finalised_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contests_slug_key').on(t.slug),
    index('contests_starts_idx').on(t.startsAt),
    index('contests_org_idx').on(t.orgId).where(sql`${t.orgId} is not null`),
    check('contests_window_ordered', sql`${t.endsAt} > ${t.startsAt}`),
    check(
      'contests_freeze_within_window',
      sql`${t.freezeMinutes} >= 0 and (${t.freezeMinutes} * interval '1 minute') < (${t.endsAt} - ${t.startsAt})`,
    ),
    check('contests_penalty_nonneg', sql`${t.penaltySecondsPerReject} >= 0`),
    check('contests_private_has_org', sql`(${t.kind} <> 'private') or (${t.orgId} is not null)`),
  ],
);

export const problems = contest.table(
  'problems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    /** Display index `A`, `B`, `C`, `D`. */
    label: text('label').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    statement: text('statement').notNull(),
    points: integer('points').notNull(),
    timeLimitMs: integer('time_limit_ms').notNull().default(2000),
    memoryMb: integer('memory_mb').notNull().default(512),
    maxQubits: smallint('max_qubits').notNull().default(20),
    graderKey: text('grader_key').notNull(),
    lessonId: integer('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
    /** §6 anti-cheat: a submission within 4 s of this is flagged. */
    opensAt: timestamp('opens_at', { withTimezone: true, mode: 'date' }),
    position: integer('position').notNull(),
  },
  (t) => [
    uniqueIndex('problems_contest_label_key').on(t.contestId, t.label),
    uniqueIndex('problems_slug_key').on(t.slug),
    uniqueIndex('problems_contest_position_key').on(t.contestId, t.position),
    check('problems_points_positive', sql`${t.points} > 0`),
    check('problems_label_shape', sql`${t.label} ~ '^[A-Z]$'`),
    check('problems_limits_positive', sql`${t.timeLimitMs} > 0 and ${t.memoryMb} > 0`),
  ],
);

export const registrations = contest.table(
  'registrations',
  {
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: registrationKind('kind').notNull().default('live'),
    /** Virtual participants run the contest on their own clock (§ contests route). */
    virtualStartAt: timestamp('virtual_start_at', { withTimezone: true, mode: 'date' }),
    rated: boolean('rated').notNull().default(true),
    registeredAt: timestamp('registered_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contestId, t.userId] }),
    index('registrations_user_idx').on(t.userId),
    check(
      'registrations_virtual_has_start',
      sql`(${t.kind} <> 'virtual') or (${t.virtualStartAt} is not null)`,
    ),
    check('registrations_virtual_is_unrated', sql`(${t.kind} <> 'virtual') or (${t.rated} = false)`),
  ],
);

export const submissions = contest.table(
  'submissions',
  {
    id: uuid('id').notNull().defaultRandom(),
    contestId: uuid('contest_id').notNull(),
    userId: uuid('user_id').notNull(),
    problemId: uuid('problem_id').notNull(),
    language: text('language').notNull(),
    source: text('source').notNull(),
    /** Normalised-AST hash: exact-duplicate detection across users (§6). */
    sourceHash: text('source_hash').notNull(),
    verdict: verdict('verdict').notNull().default('pending'),
    score: integer('score').notNull().default(0),
    /** Seconds from contest start; the leaderboard tiebreak. */
    elapsedSeconds: integer('elapsed_seconds').notNull(),
    isVirtual: boolean('is_virtual').notNull().default(false),
    /** Set when anti-cheat flags the submission; excluded from ratings. */
    flagged: boolean('flagged').notNull().default(false),
    flagReason: text('flag_reason'),
    idempotencyKey: text('idempotency_key'),
    jobId: text('job_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    judgedAt: timestamp('judged_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('contest_submissions_contest_created_idx').on(t.contestId, t.createdAt),
    index('contest_submissions_user_problem_idx').on(t.userId, t.problemId, t.createdAt),
    index('contest_submissions_source_hash_idx').on(t.contestId, t.sourceHash),
    uniqueIndex('contest_submissions_idempotency_key').on(t.userId, t.idempotencyKey, t.createdAt),
    check('contest_submissions_elapsed_nonneg', sql`${t.elapsedSeconds} >= 0`),
    check('contest_submissions_score_nonneg', sql`${t.score} >= 0`),
    check('contest_submissions_source_size', sql`length(${t.source}) <= 262144`),
  ],
);

export const standingsSnapshots = contest.table(
  'standings_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    kind: snapshotKind('kind').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    participantCount: integer('participant_count').notNull(),
  },
  (t) => [
    uniqueIndex('standings_snapshots_contest_kind_key').on(t.contestId, t.kind),
    check('standings_snapshots_count_nonneg', sql`${t.participantCount} >= 0`),
  ],
);

export const standingsRows = contest.table(
  'standings_rows',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => standingsSnapshots.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    points: integer('points').notNull(),
    penaltySeconds: integer('penalty_seconds').notNull(),
    /** `{ "<problem_id>": { "solvedAt": 1234, "attempts": 2 } }`. */
    solved: jsonb('solved')
      .$type<Record<string, { solvedAt: number; attempts: number }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ columns: [t.snapshotId, t.userId] }),
    uniqueIndex('standings_rows_snapshot_rank_key').on(t.snapshotId, t.rank),
    check('standings_rows_rank_positive', sql`${t.rank} >= 1`),
    check(
      'standings_rows_nonneg',
      sql`${t.points} >= 0 and ${t.penaltySeconds} >= 0`,
    ),
  ],
);

/** Current Glicko-2 state, one row per rated user (§6, `src/lib/glicko2.ts`). */
export const ratings = contest.table(
  'ratings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: doublePrecision('rating').notNull().default(1500),
    ratingDeviation: doublePrecision('rating_deviation').notNull().default(350),
    volatility: doublePrecision('volatility').notNull().default(0.06),
    contestsPlayed: integer('contests_played').notNull().default(0),
    peakRating: doublePrecision('peak_rating').notNull().default(1500),
    lastContestId: uuid('last_contest_id').references(() => contests.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('ratings_rating_idx').on(t.rating),
    check('ratings_rd_bounds', sql`${t.ratingDeviation} > 0 and ${t.ratingDeviation} <= 350`),
    check('ratings_volatility_bounds', sql`${t.volatility} > 0 and ${t.volatility} <= 0.1`),
    check('ratings_contests_nonneg', sql`${t.contestsPlayed} >= 0`),
  ],
);

export const ratingHistory = contest.table(
  'rating_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    contestId: uuid('contest_id')
      .notNull()
      .references(() => contests.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    ratingBefore: doublePrecision('rating_before').notNull(),
    rdBefore: doublePrecision('rd_before').notNull(),
    volatilityBefore: doublePrecision('volatility_before').notNull(),
    ratingAfter: doublePrecision('rating_after').notNull(),
    rdAfter: doublePrecision('rd_after').notNull(),
    volatilityAfter: doublePrecision('volatility_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rating_history_user_contest_key').on(t.userId, t.contestId),
    index('rating_history_contest_idx').on(t.contestId),
  ],
);

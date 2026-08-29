/**
 * `progress` schema — system-design §5 ("~40 rows/user/week").
 *
 * `progress.mastery` is the hot-path denormalisation the design calls for: one
 * row per user carrying `unlocked_lesson_ids int[]`, so "what should I do next"
 * is a single row read instead of a DAG traversal. It is recomputed inside the
 * same transaction that completes a lesson.
 *
 * `progress.xp_events` is range-partitioned weekly (§5).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
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
import { lessons, tracks, concepts } from './catalog.js';
import { users } from './identity.js';

export const progress = pgSchema('progress');

export const enrollmentStatus = progress.enum('enrollment_status', [
  'active',
  'paused',
  'completed',
  'dropped',
]);
export const lessonStatus = progress.enum('lesson_status', [
  'available',
  'in_progress',
  'completed',
  'failed',
]);
export const xpKind = progress.enum('xp_kind', [
  'lesson_complete',
  'lab_pass',
  'checkpoint_pass',
  'project_pass',
  'review',
  'contest',
  'streak_bonus',
  'adjustment',
]);

export const enrollments = progress.table(
  'enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    status: enrollmentStatus('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('enrollments_user_track_key').on(t.userId, t.trackId),
    index('enrollments_track_idx').on(t.trackId),
  ],
);

export const lessonState = progress.table(
  'lesson_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    status: lessonStatus('status').notNull().default('in_progress'),
    score: doublePrecision('score'),
    bestScore: doublePrecision('best_score'),
    attempts: integer('attempts').notNull().default(0),
    secondsSpent: integer('seconds_spent').notNull().default(0),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.lessonId] }),
    index('lesson_state_lesson_idx').on(t.lessonId),
    index('lesson_state_user_completed_idx')
      .on(t.userId, t.completedAt)
      .where(sql`${t.status} = 'completed'`),
    check('lesson_state_attempts_nonneg', sql`${t.attempts} >= 0`),
    check(
      'lesson_state_score_range',
      sql`(${t.score} is null or ${t.score} between 0 and 1) and (${t.bestScore} is null or ${t.bestScore} between 0 and 1)`,
    ),
    check(
      'lesson_state_completed_has_timestamp',
      sql`(${t.status} <> 'completed') or (${t.completedAt} is not null)`,
    ),
  ],
);

/**
 * One row per user. `unlocked_lesson_ids` and `completed_lesson_ids` are the
 * materialised DAG frontier described in §5; `version` is an optimistic-locking
 * counter so a concurrent recompute cannot silently lose an unlock.
 */
export const mastery = progress.table(
  'mastery',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    unlockedLessonIds: integer('unlocked_lesson_ids')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    completedLessonIds: integer('completed_lesson_ids')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    overallMastery: doublePrecision('overall_mastery').notNull().default(0),
    lessonsCompleted: integer('lessons_completed').notNull().default(0),
    version: integer('version').notNull().default(1),
    recomputedAt: timestamp('recomputed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('mastery_overall_range', sql`${t.overallMastery} between 0 and 1`),
    check('mastery_counts_nonneg', sql`${t.lessonsCompleted} >= 0 and ${t.version} >= 1`),
  ],
);

/**
 * Per-concept Bayesian knowledge-tracing state. Kept alongside `mastery` (not
 * inside it) because the instructor heatmap aggregates across a cohort by
 * concept, which a jsonb blob would make quadratic.
 */
export const conceptMastery = progress.table(
  'concept_mastery',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conceptId: integer('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    mastery: doublePrecision('mastery').notNull().default(0),
    /** Forgetting-curve half-life in hours; extends with each successful review. */
    halfLifeHours: doublePrecision('half_life_hours').notNull().default(24),
    observations: integer('observations').notNull().default(0),
    correct: integer('correct').notNull().default(0),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.conceptId] }),
    index('concept_mastery_concept_idx').on(t.conceptId),
    check('concept_mastery_range', sql`${t.mastery} between 0 and 1`),
    check('concept_mastery_half_life_positive', sql`${t.halfLifeHours} > 0`),
    check('concept_mastery_counts', sql`${t.correct} >= 0 and ${t.observations} >= ${t.correct}`),
  ],
);

/** Spaced-repetition queue driven by the forgetting curve (syllabus, Mastery model). */
export const reviewQueue = progress.table(
  'review_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    conceptId: integer('concept_id').references(() => concepts.id, { onDelete: 'cascade' }),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    intervalHours: doublePrecision('interval_hours').notNull().default(24),
    halfLifeHours: doublePrecision('half_life_hours').notNull().default(24),
    ease: doublePrecision('ease').notNull().default(2.5),
    repetitions: integer('repetitions').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    suspended: boolean('suspended').notNull().default(false),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('review_queue_user_lesson_key').on(t.userId, t.lessonId),
    index('review_queue_due_idx')
      .on(t.userId, t.dueAt)
      .where(sql`${t.suspended} = false`),
    check('review_queue_ease_range', sql`${t.ease} between 1.3 and 3.5`),
    check(
      'review_queue_positive_intervals',
      sql`${t.intervalHours} > 0 and ${t.halfLifeHours} > 0 and ${t.repetitions} >= 0 and ${t.lapses} >= 0`,
    ),
  ],
);

export const streaks = progress.table(
  'streaks',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    current: integer('current').notNull().default(0),
    longest: integer('longest').notNull().default(0),
    lastActiveDate: date('last_active_date', { mode: 'string' }),
    freezeTokens: smallint('freeze_tokens').notNull().default(0),
    timezone: text('timezone').notNull().default('UTC'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'streaks_nonneg',
      sql`${t.current} >= 0 and ${t.longest} >= ${t.current} and ${t.freezeTokens} >= 0`,
    ),
  ],
);

/**
 * Range-partitioned weekly (§5). The primary key carries `created_at` because
 * Postgres requires every partition key column in a unique constraint.
 */
export const xpEvents = progress.table(
  'xp_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    userId: uuid('user_id').notNull(),
    amount: integer('amount').notNull(),
    kind: xpKind('kind').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('xp_events_user_created_idx').on(t.userId, t.createdAt),
    check('xp_events_amount_nonzero', sql`${t.amount} <> 0`),
  ],
);

/** Result of the T0.M8 placement diagnostic, which writes straight into the DAG. */
export const placementResults = progress.table(
  'placement_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    score: doublePrecision('score').notNull(),
    skippedLessonIds: integer('skipped_lesson_ids')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    breakdown: jsonb('breakdown').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    takenAt: timestamp('taken_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('placement_results_user_idx').on(t.userId, t.takenAt),
    check('placement_results_score_range', sql`${t.score} between 0 and 1`),
  ],
);

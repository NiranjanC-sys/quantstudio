/**
 * `instructor` schema — the teaching constructs behind the Teams/Campus
 * instructor dashboard (system-design §7: "Instructor dashboard: yes" on Teams
 * and Campus).
 *
 * §5 does not name these tables because it enumerates the learner-facing
 * domains; the dashboard still needs somewhere to put a cohort, the assignments
 * given to it and the grades that come back. They live in their own schema so
 * the gradebook can be dropped for an org without touching `progress`, which is
 * the learner's own record and outlives any cohort.
 *
 * The per-concept mastery heatmap is a join from `cohort_members` to
 * `progress.concept_mastery`; it deliberately stores nothing of its own, so a
 * heatmap can never disagree with the learner's real mastery.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tracks } from './catalog.js';
import { orgs, users } from './identity.js';

export const instructor = pgSchema('instructor');

export const cohortMemberRole = instructor.enum('cohort_member_role', ['student', 'assistant']);
export const assignmentStatus = instructor.enum('assignment_status', [
  'not_started',
  'in_progress',
  'submitted',
  'graded',
  'excused',
]);

export const cohorts = instructor.table(
  'cohorts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** The instructor who owns the cohort; org admins can act on it too. */
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Free text, e.g. "Autumn 2026". Terms differ too much to enumerate. */
    term: text('term'),
    trackId: integer('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    /** Short code a learner types to enrol themselves. Unique while active. */
    joinCode: text('join_code').notNull(),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cohorts_org_slug_key').on(t.orgId, t.slug),
    uniqueIndex('cohorts_join_code_key').on(t.joinCode).where(sql`${t.archived} = false`),
    index('cohorts_owner_idx').on(t.ownerId),
    check('cohorts_slug_shape', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
    check('cohorts_join_code_shape', sql`${t.joinCode} ~ '^[A-Z0-9]{6,12}$'`),
    check('cohorts_name_length', sql`length(${t.name}) between 2 and 120`),
  ],
);

export const cohortMembers = instructor.table(
  'cohort_members',
  {
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: cohortMemberRole('role').notNull().default('student'),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.cohortId, t.userId] }),
    index('cohort_members_user_idx').on(t.userId),
  ],
);

export const assignments = instructor.table(
  'assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    instructions: text('instructions'),
    /**
     * The lessons the assignment covers. An `int[]` for the same reason
     * `progress.mastery.unlocked_lesson_ids` is one: the gradebook reads it once
     * per assignment and never joins through it.
     */
    lessonIds: integer('lesson_ids')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    points: integer('points').notNull().default(100),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }),
    published: boolean('published').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('assignments_cohort_idx').on(t.cohortId, t.dueAt),
    check('assignments_points_positive', sql`${t.points} > 0`),
    check('assignments_title_length', sql`length(${t.title}) between 2 and 200`),
  ],
);

/**
 * One row per (assignment, learner). `score` is the fraction of the
 * assignment's points earned, so the gradebook can average across assignments
 * with different weights without re-reading `points`.
 */
export const assignmentGrades = instructor.table(
  'assignment_grades',
  {
    assignmentId: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: assignmentStatus('status').notNull().default('not_started'),
    score: doublePrecision('score'),
    /** Auto-computed from lesson completion; kept so an override is visible. */
    autoScore: doublePrecision('auto_score'),
    feedback: text('feedback'),
    gradedBy: uuid('graded_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    gradedAt: timestamp('graded_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.assignmentId, t.userId] }),
    index('assignment_grades_user_idx').on(t.userId),
    check(
      'assignment_grades_score_range',
      sql`(${t.score} is null or ${t.score} between 0 and 1) and (${t.autoScore} is null or ${t.autoScore} between 0 and 1)`,
    ),
    check(
      'assignment_grades_graded_has_score',
      sql`(${t.status} <> 'graded') or (${t.score} is not null)`,
    ),
  ],
);

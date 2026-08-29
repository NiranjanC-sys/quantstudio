/**
 * `social` schema — system-design §5 (moderate growth): discussions attached to
 * a lesson or a contest, threaded comments, votes and moderation reports.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { lessons } from './catalog.js';
import { contests } from './contest.js';
import { users } from './identity.js';

export const social = pgSchema('social');

export const discussionKind = social.enum('discussion_kind', [
  'question',
  'hint_request',
  'editorial',
  'announcement',
  'showcase',
]);
export const voteTarget = social.enum('vote_target', ['discussion', 'comment']);
export const reportStatus = social.enum('report_status', ['open', 'reviewing', 'upheld', 'dismissed']);

export const discussions = social.table(
  'discussions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lessonId: integer('lesson_id').references(() => lessons.id, { onDelete: 'cascade' }),
    contestId: uuid('contest_id').references(() => contests.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: discussionKind('kind').notNull().default('question'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    score: integer('score').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    pinned: boolean('pinned').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('discussions_lesson_idx').on(t.lessonId, t.createdAt),
    index('discussions_contest_idx').on(t.contestId, t.createdAt),
    index('discussions_author_idx').on(t.authorId),
    check(
      'discussions_exactly_one_anchor',
      sql`(${t.lessonId} is not null) <> (${t.contestId} is not null)`,
    ),
    check('discussions_title_length', sql`length(${t.title}) between 3 and 200`),
    check('discussions_body_length', sql`length(${t.body}) between 1 and 20000`),
    check('discussions_counts_nonneg', sql`${t.commentCount} >= 0`),
  ],
);

export const comments = social.table(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discussionId: uuid('discussion_id')
      .notNull()
      .references(() => discussions.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    score: integer('score').notNull().default(0),
    accepted: boolean('accepted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('comments_discussion_idx').on(t.discussionId, t.createdAt),
    index('comments_parent_idx').on(t.parentId),
    check('comments_body_length', sql`length(${t.body}) between 1 and 20000`),
    check('comments_no_self_parent', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);

export const votes = social.table(
  'votes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: voteTarget('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    value: smallint('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.targetType, t.targetId] }),
    index('votes_target_idx').on(t.targetType, t.targetId),
    check('votes_value_range', sql`${t.value} in (-1, 1)`),
  ],
);

export const reports = social.table(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: voteTarget('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),
    status: reportStatus('status').notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('reports_status_idx').on(t.status).where(sql`${t.status} = 'open'`),
    index('reports_target_idx').on(t.targetType, t.targetId),
    check(
      'reports_reason_valid',
      sql`${t.reason} in ('spam', 'abuse', 'cheating', 'off_topic', 'solution_leak', 'other')`,
    ),
  ],
);

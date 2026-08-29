/**
 * `catalog` schema — system-design §5 ("small, read-mostly, fully cached") and
 * the syllabus in docs/research/02-syllabus.md: 8 tracks, 74 modules,
 * 331 lessons, a prerequisite DAG over lessons and a concept DAG beneath it.
 *
 * Lesson ids are plain `integer` on purpose: `progress.mastery.unlocked_lesson_ids`
 * is an `int[]`, and a uuid array would triple the size of the hottest row in
 * the product.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
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
} from 'drizzle-orm/pg-core';

export const catalog = pgSchema('catalog');

/**
 * `tsvector` is not a Drizzle built-in. Catalog search (`GET /catalog/search`)
 * runs against a stored generated column so the index can never drift from the
 * row, and no application-side trigger is needed.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const skillLevel = catalog.enum('skill_level', ['L0', 'L1', 'L2', 'L3']);
export const lessonKind = catalog.enum('lesson_kind', [
  'concept',
  'interactive',
  'lab',
  'drill',
  'checkpoint',
  'project',
]);
export const conceptEdgeKind = catalog.enum('concept_edge_kind', ['prereq', 'related']);
export const questionKind = catalog.enum('question_kind', ['coding', 'system_design', 'conceptual']);

export const tracks = catalog.table(
  'tracks',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    /** `T0` … `T7`. */
    code: text('code').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    level: skillLevel('level').notNull(),
    position: integer('position').notNull(),
    moduleCount: integer('module_count').notNull().default(0),
    lessonCount: integer('lesson_count').notNull().default(0),
    /** T0/T1 are readable on the Free plan (§7, "Lessons: T0-T1"). */
    freeTier: boolean('free_tier').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tracks_code_key').on(t.code),
    uniqueIndex('tracks_slug_key').on(t.slug),
    uniqueIndex('tracks_position_key').on(t.position),
    check('tracks_code_shape', sql`${t.code} ~ '^T[0-9]$'`),
    check('tracks_counts_nonneg', sql`${t.moduleCount} >= 0 and ${t.lessonCount} >= 0`),
  ],
);

export const modules = catalog.table(
  'modules',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    trackId: integer('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    /** `T1.M3`. */
    code: text('code').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    level: skillLevel('level').notNull(),
    position: integer('position').notNull(),
    lessonCount: integer('lesson_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('modules_code_key').on(t.code),
    uniqueIndex('modules_slug_key').on(t.slug),
    uniqueIndex('modules_track_position_key').on(t.trackId, t.position),
    check('modules_code_shape', sql`${t.code} ~ '^T[0-9][A-D]?[.]M[0-9]+$'`),
  ],
);

export const lessons = catalog.table(
  'lessons',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    moduleId: integer('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    kind: lessonKind('kind').notNull(),
    level: skillLevel('level').notNull(),
    position: integer('position').notNull(),
    estimatedMinutes: integer('estimated_minutes').notNull(),
    xp: integer('xp').notNull().default(10),
    /** `checkpoint` lessons gate the next module at 80% (syllabus, Assessment). */
    passThreshold: doublePrecision('pass_threshold').notNull().default(0.8),
    freeTier: boolean('free_tier').notNull().default(false),
    /** Present for `lab`/`project` lessons: the grader harness to run. */
    graderKey: text('grader_key'),
    mdxPath: text('mdx_path'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(slug, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('lessons_slug_key').on(t.slug),
    index('lessons_search_idx').using('gin', t.searchVector),
    uniqueIndex('lessons_module_position_key').on(t.moduleId, t.position),
    index('lessons_kind_idx').on(t.kind),
    check('lessons_estimated_minutes_positive', sql`${t.estimatedMinutes} > 0`),
    check('lessons_xp_nonneg', sql`${t.xp} >= 0`),
    check('lessons_pass_threshold_range', sql`${t.passThreshold} > 0 and ${t.passThreshold} <= 1`),
    check(
      'lessons_grader_required_for_code',
      sql`(${t.kind} not in ('lab', 'project')) or (${t.graderKey} is not null)`,
    ),
  ],
);

/**
 * The lesson prerequisite DAG (syllabus: "Lessons form a prerequisite DAG, not a
 * list"). Acyclicity is enforced by a trigger in `0001_partitions.sql` rather
 * than a constraint, because Postgres cannot express reachability declaratively.
 */
export const lessonPrereqs = catalog.table(
  'lesson_prereqs',
  {
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    prereqLessonId: integer('prereq_lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    /** A `hard` edge blocks the lesson; a `soft` edge only reorders recommendations. */
    hard: boolean('hard').notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.lessonId, t.prereqLessonId] }),
    index('lesson_prereqs_prereq_idx').on(t.prereqLessonId),
    check('lesson_prereqs_no_self_edge', sql`${t.lessonId} <> ${t.prereqLessonId}`),
  ],
);

export const concepts = catalog.table(
  'concepts',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    trackId: integer('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    /** Bayesian knowledge-tracing priors (syllabus, Mastery model). */
    priorMastery: doublePrecision('prior_mastery').notNull().default(0.1),
    learnRate: doublePrecision('learn_rate').notNull().default(0.25),
    slipRate: doublePrecision('slip_rate').notNull().default(0.1),
    guessRate: doublePrecision('guess_rate').notNull().default(0.2),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'C')`,
    ),
  },
  (t) => [
    uniqueIndex('concepts_slug_key').on(t.slug),
    index('concepts_search_idx').using('gin', t.searchVector),
    check(
      'concepts_bkt_params_range',
      sql`${t.priorMastery} between 0 and 1 and ${t.learnRate} between 0 and 1 and ${t.slipRate} between 0 and 1 and ${t.guessRate} between 0 and 1`,
    ),
  ],
);

export const conceptEdges = catalog.table(
  'concept_edges',
  {
    fromConceptId: integer('from_concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    toConceptId: integer('to_concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    kind: conceptEdgeKind('kind').notNull().default('prereq'),
    weight: doublePrecision('weight').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.fromConceptId, t.toConceptId, t.kind] }),
    index('concept_edges_to_idx').on(t.toConceptId),
    check('concept_edges_no_self_edge', sql`${t.fromConceptId} <> ${t.toConceptId}`),
    check('concept_edges_weight_positive', sql`${t.weight} > 0`),
  ],
);

export const lessonConcepts = catalog.table(
  'lesson_concepts',
  {
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    conceptId: integer('concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    weight: doublePrecision('weight').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.lessonId, t.conceptId] }),
    index('lesson_concepts_concept_idx').on(t.conceptId),
    check('lesson_concepts_weight_range', sql`${t.weight} > 0 and ${t.weight} <= 1`),
  ],
);

export const companies = catalog.table(
  'companies',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    modality: text('modality').notNull(),
    stack: text('stack').array().notNull().default(sql`'{}'::text[]`),
    briefing: text('briefing'),
    website: text('website'),
  },
  (t) => [uniqueIndex('companies_slug_key').on(t.slug)],
);

/** The interview bank (§7: 20 questions on Free, "full 240" on Pro and above). */
export const questions = catalog.table(
  'questions',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull(),
    kind: questionKind('kind').notNull(),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    difficulty: smallint('difficulty').notNull(),
    trackId: integer('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
    rubric: jsonb('rubric').$type<Array<{ criterion: string; weight: number }>>(),
    freeTier: boolean('free_tier').notNull().default(false),
    position: integer('position').notNull(),
  },
  (t) => [
    uniqueIndex('questions_slug_key').on(t.slug),
    uniqueIndex('questions_position_key').on(t.position),
    index('questions_kind_idx').on(t.kind),
    check('questions_difficulty_range', sql`${t.difficulty} between 1 and 5`),
  ],
);

/** Persona paths through the DAG (syllabus, "Roadmaps"). */
export const roadmaps = catalog.table(
  'roadmaps',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    persona: text('persona').notNull(),
    durationWeeks: integer('duration_weeks').notNull(),
    /** Ordered module codes, e.g. `["T0.M2", …, "T7.M2"]`. */
    path: jsonb('path').$type<string[]>().notNull(),
    position: integer('position').notNull(),
  },
  (t) => [
    uniqueIndex('roadmaps_slug_key').on(t.slug),
    uniqueIndex('roadmaps_position_key').on(t.position),
    check('roadmaps_duration_positive', sql`${t.durationWeeks} > 0`),
  ],
);

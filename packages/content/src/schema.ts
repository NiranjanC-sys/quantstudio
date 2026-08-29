/**
 * Zod schemas for the RedQuant content catalogue.
 *
 * These are the contract between the authored MDX under `content/` and the
 * runtime: the lesson graph, the drill scheduler, the autograder, the interview
 * bank, and the contest engine all validate against the schemas here.
 *
 * Convention reminder that these schemas encode implicitly: qubit 0 is the most
 * significant bit. A 2-qubit state `|q0 q1>` reads left to right, matching Cirq
 * and Nielsen & Chuang. Assertion payloads that name basis states use that
 * order, never Qiskit's.
 */

import { z } from 'zod';
import { SOURCE_KEYS } from './sources.js';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** `t3.m7.l2` — track 3, module 7, lesson 2. Lowercase, dot separated. */
export const LessonIdSchema = z
  .string()
  .regex(/^t[0-7]\.m[0-9]+\.l[0-9]+$/, 'lesson id must look like t1.m5.l3');

/** `t3.m7` */
export const ModuleIdSchema = z
  .string()
  .regex(/^t[0-7]\.m[0-9]+$/, 'module id must look like t1.m5');

/** `t3` */
export const TrackIdSchema = z.string().regex(/^t[0-7]$/, 'track id must look like t1');

export const LevelSchema = z.enum(['L0', 'L1', 'L2', 'L3']);

export const LessonTypeSchema = z.enum([
  'concept',
  'interactive',
  'lab',
  'drill',
  'checkpoint',
  'project',
]);

export const SourceKeySchema = z.enum(SOURCE_KEYS);

export const SourceRefSchema = z.object({
  label: z.string().min(4),
  url: z.string().url(),
});

/* -------------------------------------------------------------------------- */
/* Circuit IR (the subset the catalogue needs to carry)                        */
/* -------------------------------------------------------------------------- */

export const GATE_KEYS = [
  'id', 'x', 'y', 'z', 'h', 's', 'sdg', 't', 'tdg', 'sx', 'sxdg',
  'rx', 'ry', 'rz', 'p', 'u', 'swap', 'iswap', 'rxx', 'ryy', 'rzz', 'rzx', 'ecr',
  'cx', 'cy', 'cz', 'ch', 'cs', 'csdg', 'csx', 'cp', 'crx', 'cry', 'crz', 'cu',
  'ccx', 'ccz', 'cswap', 'mcx', 'measure', 'reset', 'barrier',
] as const;

export const GateKeySchema = z.enum(GATE_KEYS);

export const ParamSchema = z.union([z.number(), z.object({ symbol: z.string().min(1) })]);

export const OpSchema = z.object({
  id: z.string().min(1),
  gate: GateKeySchema,
  targets: z.array(z.number().int().nonnegative()),
  controls: z.array(z.number().int().nonnegative()).optional(),
  params: z.array(ParamSchema).optional(),
  cbits: z.array(z.number().int().nonnegative()).optional(),
  condition: z
    .object({ bits: z.array(z.number().int().nonnegative()), value: z.number().int() })
    .optional(),
  label: z.string().optional(),
});

export const CircuitSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  qubits: z.number().int().positive(),
  clbits: z.number().int().nonnegative(),
  ops: z.array(OpSchema),
  metadata: z.record(z.unknown()).optional(),
});

/* -------------------------------------------------------------------------- */
/* Assertions — what a grader checks                                           */
/* -------------------------------------------------------------------------- */

/**
 * One graded claim about a learner submission. `statevector` and `unitary`
 * comparisons are up to global phase unless `exactPhase` is set, because a
 * circuit that differs by an unobservable overall phase is the same circuit.
 */
export const AssertionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('statevector'),
    id: z.string().min(1),
    description: z.string().min(4),
    /** Expected amplitudes, index 0 first, qubit 0 as the most significant bit. */
    expected: z.array(z.tuple([z.number(), z.number()])),
    tolerance: z.number().positive().default(1e-6),
    upToGlobalPhase: z.boolean().default(true),
    points: z.number().nonnegative().default(1),
    hidden: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('unitary'),
    id: z.string().min(1),
    description: z.string().min(4),
    /** Row-major complex matrix, qubit 0 as the most significant bit. */
    expected: z.array(z.array(z.tuple([z.number(), z.number()]))),
    tolerance: z.number().positive().default(1e-6),
    upToGlobalPhase: z.boolean().default(true),
    points: z.number().nonnegative().default(1),
    hidden: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('distribution'),
    id: z.string().min(1),
    description: z.string().min(4),
    /** Bitstrings in qubit-0-first order mapped to expected probability. */
    expected: z.record(z.string().regex(/^[01]+$/), z.number().min(0).max(1)),
    shots: z.number().int().positive().default(4096),
    /** Total variation distance allowed between observed and expected. */
    tolerance: z.number().positive().default(0.05),
    points: z.number().nonnegative().default(1),
    hidden: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('resource'),
    id: z.string().min(1),
    description: z.string().min(4),
    maxDepth: z.number().int().positive().optional(),
    maxTwoQubitGates: z.number().int().nonnegative().optional(),
    maxTotalGates: z.number().int().nonnegative().optional(),
    maxQubits: z.number().int().positive().optional(),
    maxTCount: z.number().int().nonnegative().optional(),
    points: z.number().nonnegative().default(1),
    hidden: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('value'),
    id: z.string().min(1),
    description: z.string().min(4),
    /** Name of the symbol the harness reads out of the submission. */
    symbol: z.string().min(1),
    expected: z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]),
    tolerance: z.number().nonnegative().default(0),
    points: z.number().nonnegative().default(1),
    hidden: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('property'),
    id: z.string().min(1),
    description: z.string().min(4),
    /** A predicate the harness evaluates over randomly generated inputs. */
    predicate: z.string().min(4),
    trials: z.number().int().positive().default(50),
    seed: z.number().int().nonnegative().default(0),
    points: z.number().nonnegative().default(1),
    hidden: z.boolean().default(false),
  }),
]);

export type Assertion = z.infer<typeof AssertionSchema>;

/* -------------------------------------------------------------------------- */
/* Labs                                                                        */
/* -------------------------------------------------------------------------- */

export const LanguageSchema = z.enum(['qiskit', 'cirq', 'pennylane', 'openqasm3', 'python', 'typescript']);

export const ResourceBoundsSchema = z.object({
  /** Wall-clock seconds the grader allows for the whole submission. */
  timeLimitSeconds: z.number().positive().default(30),
  memoryLimitMb: z.number().positive().default(512),
  maxQubits: z.number().int().positive().default(12),
  maxShots: z.number().int().positive().default(20000),
  /** Whether the submission may call a real backend. Almost always false. */
  networkAllowed: z.boolean().default(false),
});

export const LabSpecSchema = z.object({
  language: LanguageSchema,
  /** What the learner must produce, in one or two sentences. */
  task: z.string().min(20),
  starterCode: z.string().min(10),
  /** Visible to the learner; failing these should be diagnosable from the message. */
  publicTests: z.array(AssertionSchema).min(1),
  /** Decide the grade. Never shown before submission. */
  hiddenTests: z.array(AssertionSchema).min(1),
  bounds: ResourceBoundsSchema,
  /** Reference implementation, withheld until the learner passes or gives up. */
  solution: z.string().optional(),
});

export type LabSpec = z.infer<typeof LabSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Lessons, modules, tracks                                                    */
/* -------------------------------------------------------------------------- */

export const LessonSchema = z.object({
  id: LessonIdSchema,
  title: z.string().min(3),
  type: LessonTypeSchema,
  track: TrackIdSchema,
  module: ModuleIdSchema,
  level: LevelSchema,
  /** Estimated time on task, in minutes. */
  minutes: z.number().int().positive(),
  /** Two to four verb-first, testable statements. */
  objectives: z.array(z.string().min(10)).min(2).max(4),
  /** Lesson ids that must be mastered first. Forms a DAG with every other node. */
  prerequisites: z.array(LessonIdSchema),
  sources: z.array(SourceRefSchema).min(1),
  lab: LabSpecSchema.optional(),
  /** Relative path of the authored MDX, when prose exists. */
  path: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type Lesson = z.infer<typeof LessonSchema>;
export type LessonType = z.infer<typeof LessonTypeSchema>;
export type Level = z.infer<typeof LevelSchema>;

export const ModuleSchema = z.object({
  id: ModuleIdSchema,
  title: z.string().min(3),
  track: TrackIdSchema,
  /** 1-based position within the track. */
  order: z.number().int().positive(),
  summary: z.string().min(20),
  lessons: z.array(LessonIdSchema).min(1),
});

export type Module = z.infer<typeof ModuleSchema>;

export const TrackSchema = z.object({
  id: TrackIdSchema,
  code: z.string().regex(/^T[0-7]$/),
  title: z.string().min(3),
  level: z.array(LevelSchema).min(1),
  summary: z.string().min(20),
  modules: z.array(ModuleIdSchema).min(1),
});

export type Track = z.infer<typeof TrackSchema>;

/* -------------------------------------------------------------------------- */
/* Concept graph                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A concept node is the unit the mastery model tracks. Most lessons teach
 * exactly one; a few teach two. Mastery decays per node, not per lesson.
 */
export const ConceptNodeSchema = z.object({
  id: z.string().regex(/^c\.[a-z0-9-]+$/, 'concept id must look like c.born-rule'),
  label: z.string().min(3),
  /** Lessons that teach this concept. */
  lessons: z.array(LessonIdSchema).min(1),
  /** Forgetting-curve half-life in days at mastery 1.0, before any review. */
  halfLifeDays: z.number().positive().default(7),
});

export type ConceptNode = z.infer<typeof ConceptNodeSchema>;

export const ConceptEdgeSchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  kind: z.enum(['requires', 'refines', 'applies']),
});

export type ConceptEdge = z.infer<typeof ConceptEdgeSchema>;

/* -------------------------------------------------------------------------- */
/* Drills                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A spaced-repetition card, in the sense of benchmark source 14: the card
 * promises the learner will remember the answer permanently. One fact per card,
 * deliberately redundant across cards, and the answer must be falsifiable.
 */
export const DrillCardSchema = z.object({
  id: z.string().min(3),
  module: ModuleIdSchema,
  /** The lesson the fact comes from. */
  lesson: LessonIdSchema,
  front: z.string().min(8),
  back: z.string().min(2),
  /** Optional KaTeX shown under the answer. */
  math: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export type DrillCard = z.infer<typeof DrillCardSchema>;

/* -------------------------------------------------------------------------- */
/* Roadmaps                                                                    */
/* -------------------------------------------------------------------------- */

export const RoadmapWeekSchema = z.object({
  week: z.number().int().positive(),
  focus: z.string().min(4),
  nodes: z.array(LessonIdSchema).min(1),
});

export const RoadmapSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(3),
  persona: z.string().min(4),
  weeks: z.number().int().positive(),
  /** What the learner is assumed to arrive with. */
  assumes: z.string().min(10),
  outcome: z.string().min(10),
  schedule: z.array(RoadmapWeekSchema).min(1),
});

export type Roadmap = z.infer<typeof RoadmapSchema>;

/* -------------------------------------------------------------------------- */
/* Interview bank                                                              */
/* -------------------------------------------------------------------------- */

export const DifficultySchema = z.enum(['easy', 'medium', 'hard']);

export const InterviewQuestionSchema = z.object({
  id: z.string().regex(/^(iq|sd)-[0-9]{3}$/, 'interview id must look like iq-001 or sd-001'),
  title: z.string().min(6),
  kind: z.enum(['coding', 'system-design']),
  prompt: z.string().min(40),
  difficulty: DifficultySchema,
  /** Which of the 30 benchmark patterns this instantiates. */
  pattern: z.string().min(3),
  topics: z.array(z.string().min(2)).min(1),
  companies: z.array(z.string().min(2)),
  /** A real answer a candidate could learn from, not a hint. */
  modelAnswer: z.string().min(200),
  followUps: z.array(z.string().min(8)).min(1),
  commonMistakes: z.array(z.string().min(8)).min(1),
  references: z.array(SourceRefSchema).min(1),
});

export type InterviewQuestion = z.infer<typeof InterviewQuestionSchema>;

export const CompanySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(2),
  modality: z.string().min(4),
  primarySdk: z.string().min(2),
  /** What interviews at this employer actually cover. */
  asks: z.array(z.string().min(10)).min(2),
  roles: z.array(z.string().min(3)).min(1),
  links: z.array(SourceRefSchema).min(1),
  notes: z.string().min(20),
});

export type Company = z.infer<typeof CompanySchema>;

/* -------------------------------------------------------------------------- */
/* Contests                                                                    */
/* -------------------------------------------------------------------------- */

export const ContestProblemSchema = z.object({
  id: z.string().regex(/^c[0-9]{2}-p[0-9]$/, 'contest problem id must look like c01-p3'),
  contest: z.string().regex(/^c[0-9]{2}$/),
  index: z.number().int().min(1).max(4),
  title: z.string().min(4),
  difficulty: DifficultySchema,
  /** Points awarded for a fully correct submission. */
  points: z.number().int().positive(),
  /** Minutes added to elapsed time per wrong submission on a solved problem. */
  penaltyMinutes: z.number().int().nonnegative().default(5),
  /** Relative path to the MDX statement. */
  statementPath: z.string().min(4),
  language: LanguageSchema,
  starterCode: z.string().min(10),
  publicTests: z.array(AssertionSchema).min(3),
  hiddenTests: z.array(AssertionSchema).min(8),
  bounds: ResourceBoundsSchema,
  solution: z.string().min(20),
  editorial: z.string().min(200),
  topics: z.array(z.string().min(2)).min(1),
});

export type ContestProblem = z.infer<typeof ContestProblemSchema>;

export const ContestSchema = z.object({
  id: z.string().regex(/^c[0-9]{2}$/),
  title: z.string().min(4),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.number().int().positive(),
  ratingRange: z.tuple([z.number().int(), z.number().int()]),
  problems: z.array(z.string()).length(4),
});

export type Contest = z.infer<typeof ContestSchema>;

/* -------------------------------------------------------------------------- */
/* Whole-catalogue shape                                                       */
/* -------------------------------------------------------------------------- */

export const CatalogSchema = z.object({
  tracks: z.array(TrackSchema),
  modules: z.array(ModuleSchema),
  lessons: z.array(LessonSchema),
});

export type Catalog = z.infer<typeof CatalogSchema>;

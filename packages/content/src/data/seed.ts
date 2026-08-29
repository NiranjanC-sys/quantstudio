/**
 * Internal authoring types for the catalogue.
 *
 * Track files (`t0.ts` … `t7.ts`) export a `TrackSeed`. `catalog.ts` flattens
 * them into ids, expands source keys into `{label, url}` pairs, and validates
 * the result against the Zod schemas. Authors never write ids by hand: an id is
 * derived from track code plus module number plus lesson number, which is what
 * makes the counts in the syllabus checkable by a test.
 */

import type { LessonType, Level } from '../types.js';
import type { SourceKey } from '../sources.js';
import type { Assertion, LabSpec } from '../schema.js';

export interface LessonSeed {
  /** 1-based position within the module. */
  n: number;
  title: string;
  type: LessonType;
  minutes: number;
  /** Two to four verb-first, testable objectives. */
  objectives: string[];
  /** Fully qualified prerequisite lesson ids, e.g. `t0.m3.l2`. */
  prereqs: string[];
  sources: SourceKey[];
  /** Overrides the slug derived from the title. */
  slug?: string;
  /** Overrides the track default level. */
  level?: Level;
  tags?: string[];
  lab?: LabSpec;
  /** Set on lessons whose MDX prose is authored. */
  authored?: boolean;
}

export interface ModuleSeed {
  /** 1-based position within the track. */
  n: number;
  title: string;
  summary: string;
  lessons: LessonSeed[];
}

export interface TrackSeed {
  id: string;
  code: string;
  title: string;
  level: Level[];
  summary: string;
  modules: ModuleSeed[];
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                           */
/* -------------------------------------------------------------------------- */

export type Cx = [number, number];

const R2 = Math.SQRT1_2;
/** 1/sqrt(2) as a real amplitude, the number that shows up in half of all labs. */
export const H1: Cx = [R2, 0];
export const NH1: Cx = [-R2, 0];
export const ZERO: Cx = [0, 0];
export const ONE: Cx = [1, 0];

export function bounds(over: Partial<LabSpec['bounds']> = {}): LabSpec['bounds'] {
  return {
    timeLimitSeconds: 30,
    memoryLimitMb: 512,
    maxQubits: 12,
    maxShots: 20000,
    networkAllowed: false,
    ...over,
  };
}

interface Opt {
  points?: number;
  hidden?: boolean;
  tolerance?: number;
}

export function sv(id: string, description: string, expected: Cx[], o: Opt = {}): Assertion {
  return {
    kind: 'statevector',
    id,
    description,
    expected,
    tolerance: o.tolerance ?? 1e-6,
    upToGlobalPhase: true,
    points: o.points ?? 1,
    hidden: o.hidden ?? false,
  };
}

export function uni(id: string, description: string, expected: Cx[][], o: Opt = {}): Assertion {
  return {
    kind: 'unitary',
    id,
    description,
    expected,
    tolerance: o.tolerance ?? 1e-6,
    upToGlobalPhase: true,
    points: o.points ?? 1,
    hidden: o.hidden ?? false,
  };
}

export function dist(
  id: string,
  description: string,
  expected: Record<string, number>,
  o: Opt & { shots?: number } = {},
): Assertion {
  return {
    kind: 'distribution',
    id,
    description,
    expected,
    shots: o.shots ?? 4096,
    tolerance: o.tolerance ?? 0.05,
    points: o.points ?? 1,
    hidden: o.hidden ?? false,
  };
}

export function res(
  id: string,
  description: string,
  limits: {
    maxDepth?: number;
    maxTwoQubitGates?: number;
    maxTotalGates?: number;
    maxQubits?: number;
    maxTCount?: number;
  },
  o: Opt = {},
): Assertion {
  return {
    kind: 'resource',
    id,
    description,
    ...limits,
    points: o.points ?? 1,
    hidden: o.hidden ?? false,
  };
}

export function val(
  id: string,
  description: string,
  symbol: string,
  expected: number | string | boolean | number[],
  o: Opt = {},
): Assertion {
  return {
    kind: 'value',
    id,
    description,
    symbol,
    expected,
    tolerance: o.tolerance ?? 0,
    points: o.points ?? 1,
    hidden: o.hidden ?? false,
  };
}

export function prop(
  id: string,
  description: string,
  predicate: string,
  o: Opt & { trials?: number; seed?: number } = {},
): Assertion {
  return {
    kind: 'property',
    id,
    description,
    predicate,
    trials: o.trials ?? 50,
    seed: o.seed ?? 0,
    points: o.points ?? 1,
    hidden: o.hidden ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* Amplitude-vector helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A computational basis state as an amplitude vector. `index` is read with
 * qubit 0 as the most significant bit, so on three qubits `|011>` is index 3.
 */
export function basis(dim: number, index: number): Cx[] {
  const v: Cx[] = Array.from({ length: dim }, () => [0, 0] as Cx);
  v[index] = [1, 0];
  return v;
}

/** A sparse superposition: `{6: [R2, 0], 13: [R2, 0]}` style, zeros elsewhere. */
export function superpose(dim: number, amps: Record<number, Cx>): Cx[] {
  const v: Cx[] = Array.from({ length: dim }, () => [0, 0] as Cx);
  for (const [k, a] of Object.entries(amps)) v[Number(k)] = a;
  return v;
}

/**
 * The unitary of a classical permutation of basis states. Column `j` carries its
 * single 1 in row `perm(j)`, with qubit 0 as the most significant bit. Use it to
 * write out CCX, CSWAP and oracle matrices without transcribing 64 entries.
 */
export function permUnitary(dim: number, perm: (j: number) => number): Cx[][] {
  const M: Cx[][] = Array.from({ length: dim }, () =>
    Array.from({ length: dim }, () => [0, 0] as Cx),
  );
  for (let j = 0; j < dim; j += 1) M[perm(j)]![j] = [1, 0];
  return M;
}

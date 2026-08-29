import { describe, expect, it } from 'vitest';

import {
  CATALOG_COUNTS,
  DAG_NODES,
  LESSONS,
  MODULES,
  TRACKS,
  getLesson,
  getModule,
  lessonsOfModule,
  lessonsOfTrack,
  slugify,
} from '../src/catalog.js';
import { BENCHMARK_SOURCES, SOURCE_KEYS } from '../src/sources.js';
import { LabSpecSchema, LessonSchema } from '../src/schema.js';

/** The counts the syllabus commits to, in docs/research/02-syllabus.md. */
const SYLLABUS = {
  tracks: 8,
  modules: 74,
  lessons: 331,
  perTrack: {
    t0: { modules: 8, lessons: 31 },
    t1: { modules: 12, lessons: 61 },
    t2: { modules: 10, lessons: 48 },
    t3: { modules: 9, lessons: 41 },
    t4: { modules: 8, lessons: 42 },
    t5: { modules: 14, lessons: 63 },
    t6: { modules: 7, lessons: 30 },
    t7: { modules: 6, lessons: 15 },
  },
} as const;

describe('catalogue shape', () => {
  it('has exactly the tracks, modules and lessons the syllabus commits to', () => {
    expect(CATALOG_COUNTS).toEqual(SYLLABUS);
  });

  it('matches the per-track module and lesson counts', () => {
    for (const [trackId, expected] of Object.entries(SYLLABUS.perTrack)) {
      expect({
        track: trackId,
        modules: MODULES.filter((m) => m.track === trackId).length,
        lessons: lessonsOfTrack(trackId).length,
      }).toEqual({ track: trackId, ...expected });
    }
  });

  it('gives every lesson a unique id', () => {
    const ids = LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('numbers modules contiguously from 1 within each track', () => {
    for (const track of TRACKS) {
      const orders = MODULES.filter((m) => m.track === track.id)
        .map((m) => m.order)
        .sort((a, b) => a - b);
      expect(orders).toEqual(orders.map((_, i) => i + 1));
    }
  });

  it('numbers lessons contiguously from 1 within each module', () => {
    for (const module of MODULES) {
      const numbers = module.lessons.map((id) => Number(id.split('.l')[1]));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });

  it('keeps every module lesson list consistent with the lesson records', () => {
    for (const module of MODULES) {
      expect(lessonsOfModule(module.id).map((l) => l.id)).toEqual(module.lessons);
    }
  });

  it('lists every module of a track exactly once on the track record', () => {
    for (const track of TRACKS) {
      const owned = MODULES.filter((m) => m.track === track.id).map((m) => m.id);
      expect(track.modules).toEqual(owned);
      expect(new Set(track.modules).size).toBe(track.modules.length);
    }
  });
});

describe('lesson records', () => {
  it('validates every lesson against the Zod schema', () => {
    for (const lesson of LESSONS) {
      expect(() => LessonSchema.parse(lesson)).not.toThrow();
    }
  });

  it('cites at least one benchmark source per lesson', () => {
    const urls = new Set(SOURCE_KEYS.map((k) => BENCHMARK_SOURCES[k].url));
    const offenders = LESSONS.filter(
      (l) => l.sources.length === 0 || !l.sources.some((s) => urls.has(s.url)),
    ).map((l) => l.id);
    expect(offenders).toEqual([]);
  });

  it('gives every lesson two to four verb-first objectives', () => {
    const offenders = LESSONS.filter(
      (l) => l.objectives.length < 2 || l.objectives.length > 4,
    ).map((l) => l.id);
    expect(offenders).toEqual([]);
  });

  it('never lets a lesson be its own prerequisite', () => {
    const offenders = LESSONS.filter((l) => l.prerequisites.includes(l.id)).map((l) => l.id);
    expect(offenders).toEqual([]);
  });

  it('never repeats a prerequisite on a lesson', () => {
    const offenders = LESSONS.filter(
      (l) => new Set(l.prerequisites).size !== l.prerequisites.length,
    ).map((l) => l.id);
    expect(offenders).toEqual([]);
  });

  it('gives every lesson a positive time estimate under six hours', () => {
    const offenders = LESSONS.filter((l) => l.minutes <= 0 || l.minutes > 360).map((l) => l.id);
    expect(offenders).toEqual([]);
  });

  it('derives an MDX path for every authored lesson and none for the rest', () => {
    const authored = LESSONS.filter((l) => l.path !== undefined);
    for (const lesson of authored) {
      const [, module] = lesson.module.split('.m');
      const n = lesson.id.split('.l')[1];
      expect(lesson.path).toBe(
        `tracks/${lesson.track}/m${module}/l${n}-${slugify(lesson.title)}.mdx`,
      );
    }
    // T0 and T1 are the tracks whose prose is authored in this release.
    expect(authored.filter((l) => l.track === 't0').length).toBe(31);
    expect(authored.filter((l) => l.track === 't1').length).toBe(61);
  });
});

describe('lab specifications', () => {
  const labs = LESSONS.filter((l) => l.type === 'lab');

  it('attaches a LabSpec to every lab lesson', () => {
    const missing = labs.filter((l) => l.lab === undefined).map((l) => l.id);
    expect(missing).toEqual([]);
  });

  it('validates every LabSpec and requires public and hidden tests', () => {
    for (const lesson of labs) {
      expect(() => LabSpecSchema.parse(lesson.lab)).not.toThrow();
      expect(lesson.lab!.publicTests.length).toBeGreaterThanOrEqual(1);
      expect(lesson.lab!.hiddenTests.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('marks every hidden test hidden', () => {
    const offenders: string[] = [];
    for (const lesson of labs) {
      for (const test of lesson.lab!.hiddenTests) {
        if (!test.hidden) offenders.push(`${lesson.id}:${test.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every assertion in a lab a unique id within that lab', () => {
    for (const lesson of labs) {
      const ids = [...lesson.lab!.publicTests, ...lesson.lab!.hiddenTests].map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('bounds every lab in time, memory and qubits', () => {
    for (const lesson of labs) {
      const b = lesson.lab!.bounds;
      expect(b.timeLimitSeconds).toBeGreaterThan(0);
      expect(b.memoryLimitMb).toBeGreaterThan(0);
      expect(b.maxQubits).toBeGreaterThan(0);
      expect(b.networkAllowed).toBe(false);
    }
  });
});

describe('helpers', () => {
  it('slugifies titles into filename-safe strings', () => {
    expect(slugify('Bits and States')).toBe('bits-and-states');
    expect(slugify("Deutsch's Algorithm")).toBe('deutschs-algorithm');
    expect(slugify('X, Y, Z')).toBe('x-y-z');
  });

  it('resolves ids through the indexes', () => {
    expect(getLesson('t1.m1.l1')?.title).toBe('From Probabilistic Bit to Real-Valued Qubit');
    expect(getModule('t1.m1')?.title).toBe('The Qubit');
    expect(getLesson('t9.m9.l9')).toBeUndefined();
  });

  it('exposes one DAG node per lesson', () => {
    expect(DAG_NODES.length).toBe(LESSONS.length);
  });
});

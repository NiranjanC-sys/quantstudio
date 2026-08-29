/**
 * The RedQuant catalogue: 8 tracks, 74 modules, 331 lessons.
 *
 * Track seeds under `./data` are the authoring surface. This module flattens
 * them into stable ids, expands benchmark source keys into `{label, url}` pairs,
 * derives the MDX path for authored lessons, and validates the whole thing
 * against the Zod schemas so a malformed seed fails at import rather than in a
 * page render.
 */

import { refs, type SourceKey } from './sources.js';
import {
  LessonSchema,
  ModuleSchema,
  TrackSchema,
  type Lesson,
  type Module,
  type Track,
} from './schema.js';
import type { LessonSeed, ModuleSeed, TrackSeed } from './data/seed.js';
import { T0 } from './data/t0.js';
import { T1 } from './data/t1.js';
import { T2 } from './data/t2.js';
import { T3 } from './data/t3.js';
import { T4 } from './data/t4.js';
import { T5 } from './data/t5.js';
import { T6 } from './data/t6.js';
import { T7 } from './data/t7.js';

export const TRACK_SEEDS: TrackSeed[] = [T0, T1, T2, T3, T4, T5, T6, T7];

/** Title to filename slug: lowercase, alphanumerics and hyphens only. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function lessonId(track: TrackSeed, module: ModuleSeed, lesson: LessonSeed): string {
  return `${track.id}.m${module.n}.l${lesson.n}`;
}

export function moduleId(track: TrackSeed, module: ModuleSeed): string {
  return `${track.id}.m${module.n}`;
}

function buildLesson(track: TrackSeed, module: ModuleSeed, seed: LessonSeed): Lesson {
  const id = lessonId(track, module, seed);
  const slug = seed.slug ?? slugify(seed.title);
  const level = seed.level ?? track.level[0]!;
  const lesson = {
    id,
    title: seed.title,
    type: seed.type,
    track: track.id,
    module: moduleId(track, module),
    level,
    minutes: seed.minutes,
    objectives: seed.objectives,
    prerequisites: seed.prereqs,
    sources: refs(...(seed.sources as SourceKey[])),
    ...(seed.lab ? { lab: seed.lab } : {}),
    ...(seed.authored ? { path: `tracks/${track.id}/m${module.n}/l${seed.n}-${slug}.mdx` } : {}),
    tags: seed.tags ?? [],
  };
  return LessonSchema.parse(lesson);
}

const lessons: Lesson[] = [];
const modules: Module[] = [];
const tracks: Track[] = [];

for (const track of TRACK_SEEDS) {
  const moduleIds: string[] = [];
  for (const module of track.modules) {
    const ids: string[] = [];
    for (const seed of module.lessons) {
      const lesson = buildLesson(track, module, seed);
      lessons.push(lesson);
      ids.push(lesson.id);
    }
    const built = ModuleSchema.parse({
      id: moduleId(track, module),
      title: module.title,
      track: track.id,
      order: module.n,
      summary: module.summary,
      lessons: ids,
    });
    modules.push(built);
    moduleIds.push(built.id);
  }
  tracks.push(
    TrackSchema.parse({
      id: track.id,
      code: track.code,
      title: track.title,
      level: track.level,
      summary: track.summary,
      modules: moduleIds,
    }),
  );
}

export const LESSONS: readonly Lesson[] = Object.freeze(lessons);
export const MODULES: readonly Module[] = Object.freeze(modules);
export const TRACKS: readonly Track[] = Object.freeze(tracks);

const lessonIndex = new Map(LESSONS.map((l) => [l.id, l]));
const moduleIndex = new Map(MODULES.map((m) => [m.id, m]));
const trackIndex = new Map(TRACKS.map((t) => [t.id, t]));

export function getLesson(id: string): Lesson | undefined {
  return lessonIndex.get(id);
}
export function getModule(id: string): Module | undefined {
  return moduleIndex.get(id);
}
export function getTrack(id: string): Track | undefined {
  return trackIndex.get(id);
}

export function lessonsOfTrack(trackId: string): Lesson[] {
  return LESSONS.filter((l) => l.track === trackId);
}
export function lessonsOfModule(moduleIdValue: string): Lesson[] {
  return LESSONS.filter((l) => l.module === moduleIdValue);
}

/** The node set the DAG utilities operate on. */
export const DAG_NODES = LESSONS.map((l) => ({ id: l.id, prerequisites: l.prerequisites }));

/** Total estimated time on task, in minutes, for a set of lesson ids. */
export function minutesFor(ids: readonly string[]): number {
  return ids.reduce((sum, id) => sum + (lessonIndex.get(id)?.minutes ?? 0), 0);
}

export const CATALOG_COUNTS = {
  tracks: TRACKS.length,
  modules: MODULES.length,
  lessons: LESSONS.length,
} as const;

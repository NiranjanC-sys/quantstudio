/**
 * The seven persona roadmaps from the syllabus.
 *
 * A roadmap is an ordered walk through a subset of the DAG, cut into weeks. The
 * node lists are derived from the catalogue rather than transcribed, so a
 * roadmap can never reference a lesson that does not exist, and the week cuts
 * are computed from estimated minutes so the weeks are actually comparable in
 * size. The order within a selection is catalogue order, which already respects
 * prerequisites inside a track.
 */

import { LESSONS, MODULES, getLesson, getModule } from './catalog.js';
import { RoadmapSchema, type Lesson, type LessonType, type Roadmap } from './schema.js';

/** A slice of the catalogue: whole modules, optionally filtered by lesson type. */
interface Selection {
  /** Module ids, in the order the learner meets them. */
  modules: string[];
  /** Keep only these lesson types. Omit to keep everything. */
  only?: LessonType[];
  /** Drop these lesson types. Applied after `only`. */
  without?: LessonType[];
}

interface RoadmapSpec {
  id: string;
  title: string;
  persona: string;
  weeks: number;
  assumes: string;
  outcome: string;
  selections: Selection[];
}

function modulesInRange(track: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n += 1) {
    const id = `${track}.m${n}`;
    if (getModule(id)) out.push(id);
  }
  return out;
}

function allModulesOf(track: string): string[] {
  return MODULES.filter((m) => m.track === track).map((m) => m.id);
}

function expand(selections: Selection[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const sel of selections) {
    for (const moduleIdValue of sel.modules) {
      const module = getModule(moduleIdValue);
      if (!module) throw new Error(`roadmap references unknown module '${moduleIdValue}'`);
      for (const lessonIdValue of module.lessons) {
        const lesson = getLesson(lessonIdValue) as Lesson;
        if (sel.only && !sel.only.includes(lesson.type)) continue;
        if (sel.without && sel.without.includes(lesson.type)) continue;
        if (seen.has(lesson.id)) continue;
        seen.add(lesson.id);
        ids.push(lesson.id);
      }
    }
  }
  return ids;
}

/**
 * Cut an ordered id list into `weeks` contiguous groups of roughly equal
 * estimated minutes, leaving at least one lesson in every week.
 */
function cutIntoWeeks(ids: string[], weeks: number): string[][] {
  if (ids.length < weeks) {
    throw new Error(`cannot cut ${ids.length} lessons into ${weeks} non-empty weeks`);
  }
  const cost = ids.map((id) => getLesson(id)?.minutes ?? 0);
  const total = cost.reduce((a, b) => a + b, 0);
  const out: string[][] = [];
  let current: string[] = [];
  let acc = 0;
  let spent = 0;

  for (let i = 0; i < ids.length; i += 1) {
    current.push(ids[i]!);
    acc += cost[i]!;
    spent += cost[i]!;
    const weeksLeft = weeks - out.length - 1;
    const lessonsLeft = ids.length - i - 1;
    const target = (total - (spent - acc)) / (weeksLeft + 1);
    const mustClose = lessonsLeft === weeksLeft && weeksLeft > 0;
    if (weeksLeft > 0 && (acc >= target || mustClose)) {
      out.push(current);
      current = [];
      acc = 0;
    }
  }
  if (current.length > 0) out.push(current);
  while (out.length > weeks) {
    const tail = out.pop()!;
    out[out.length - 1]!.push(...tail);
  }
  return out;
}

function build(spec: RoadmapSpec): Roadmap {
  const ids = expand(spec.selections);
  const chunks = cutIntoWeeks(ids, spec.weeks);
  const schedule = chunks.map((nodes, i) => {
    const first = getLesson(nodes[0]!);
    const module = first ? getModule(first.module) : undefined;
    return { week: i + 1, focus: module?.title ?? 'Review', nodes };
  });
  return RoadmapSchema.parse({
    id: spec.id,
    title: spec.title,
    persona: spec.persona,
    weeks: spec.weeks,
    assumes: spec.assumes,
    outcome: spec.outcome,
    schedule,
  });
}

const SPECS: RoadmapSpec[] = [
  {
    id: 'cs-student',
    title: 'CS student',
    persona: 'An undergraduate who has done discrete maths and linear algebra but no quantum.',
    weeks: 14,
    assumes: 'Comfort with proofs, big-O, and linear algebra; no physics background required.',
    outcome:
      'Can derive and implement the standard algorithms, reason about query complexity, and pass a quantum coding screen.',
    selections: [
      { modules: modulesInRange('t0', 2, 6) },
      { modules: allModulesOf('t1') },
      { modules: allModulesOf('t2') },
      { modules: modulesInRange('t3', 1, 3) },
      { modules: ['t7.m2'] },
    ],
  },
  {
    id: 'physics-student',
    title: 'Physics student',
    persona: 'A physics undergraduate or masters student who already knows Hilbert spaces.',
    weeks: 12,
    assumes: 'Linear algebra and quantum mechanics; little or no programming.',
    outcome:
      'Can work with density matrices and channels, follow a QEC paper, and run a chemistry experiment end to end.',
    selections: [
      { modules: modulesInRange('t0', 6, 7) },
      { modules: allModulesOf('t1'), without: ['lab', 'project'] },
      { modules: allModulesOf('t4') },
      { modules: modulesInRange('t5', 1, 4) },
      { modules: allModulesOf('t6') },
    ],
  },
  {
    id: 'swe-to-quantum-sde',
    title: 'Software engineer to quantum SDE',
    persona: 'A working software engineer targeting a quantum software role.',
    weeks: 16,
    assumes: 'Strong Python and systems engineering; rusty linear algebra.',
    outcome:
      'Can build, transpile, test and benchmark quantum software, and answer both interview tracks.',
    selections: [
      { modules: allModulesOf('t0') },
      { modules: allModulesOf('t1') },
      // T2.M1 to M5 precedes T3 because T3.M4 estimates the cost of Shor at
      // scale, which is not a meaningful exercise before Shor is taught.
      { modules: modulesInRange('t2', 1, 5) },
      { modules: allModulesOf('t3') },
      { modules: modulesInRange('t7', 2, 4) },
    ],
  },
  {
    id: 'data-scientist-to-qml',
    title: 'Data scientist to QML',
    persona: 'A data scientist who wants to evaluate quantum machine learning honestly.',
    weeks: 9,
    assumes: 'Classical ML, NumPy and PyTorch; no quantum background.',
    outcome:
      'Can build a quantum kernel and a variational classifier, and say precisely where the advantage claims stand.',
    selections: [
      { modules: modulesInRange('t0', 2, 5) },
      { modules: modulesInRange('t1', 1, 9) },
      // T3.M6 to M8 precedes the QML modules: those lessons assert on
      // measured distributions and shot budgets, which T3.M6 is what teaches.
      { modules: modulesInRange('t3', 6, 8) },
      { modules: modulesInRange('t5', 9, 11) },
    ],
  },
  {
    id: 'researcher',
    title: 'Researcher',
    persona: 'A graduate researcher entering quantum information from an adjacent field.',
    weeks: 20,
    assumes: 'Graduate mathematics and the ability to read papers; passes the T0 placement.',
    outcome:
      'Can read and reproduce a current result, and defend an original project to peers.',
    selections: [
      { modules: ['t0.m8'] },
      { modules: allModulesOf('t2') },
      { modules: allModulesOf('t4') },
      { modules: modulesInRange('t5', 1, 4) },
      { modules: ['t7.m1', 't7.m6'] },
    ],
  },
  {
    id: 'security-to-pqc',
    title: 'Security engineer to PQC',
    persona: 'A security engineer who must plan a post-quantum migration.',
    weeks: 7,
    assumes: 'Applied cryptography and TLS; no quantum background.',
    outcome:
      'Can state what Shor and Grover actually break, and produce a defensible migration plan and inventory.',
    selections: [
      { modules: modulesInRange('t0', 1, 2) },
      { modules: modulesInRange('t1', 1, 7) },
      { modules: ['t2.m2', 't2.m5'] },
      { modules: modulesInRange('t5', 12, 14) },
    ],
  },
  {
    id: 'technical-manager',
    title: 'Technical manager',
    persona: 'An engineering manager who must judge quantum proposals without writing the code.',
    weeks: 4,
    assumes: 'Technical literacy and budget responsibility; no quantum background.',
    outcome:
      'Can read a resource estimate, question a benchmark, and price a cloud QPU workload.',
    selections: [
      { modules: modulesInRange('t1', 1, 5), only: ['concept', 'interactive'] },
      { modules: ['t3.m4'], without: ['lab', 'project'] },
      { modules: ['t6.m5'], without: ['lab', 'project'] },
      { modules: modulesInRange('t5', 5, 8), without: ['lab', 'project'] },
    ],
  },
];

export const ROADMAPS: readonly Roadmap[] = Object.freeze(SPECS.map(build));

const roadmapIndex = new Map(ROADMAPS.map((r) => [r.id, r]));

export function getRoadmap(id: string): Roadmap | undefined {
  return roadmapIndex.get(id);
}

/** Every lesson id a roadmap schedules, in order. */
export function roadmapNodes(id: string): string[] {
  const r = roadmapIndex.get(id);
  if (!r) return [];
  return r.schedule.flatMap((w) => w.nodes);
}

/** Minutes of study a roadmap asks for, per week. */
export function roadmapLoad(id: string): number[] {
  const r = roadmapIndex.get(id);
  if (!r) return [];
  return r.schedule.map((w) =>
    w.nodes.reduce((sum, n) => sum + (LESSONS.find((l) => l.id === n)?.minutes ?? 0), 0),
  );
}

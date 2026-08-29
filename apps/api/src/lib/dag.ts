/**
 * The lesson prerequisite DAG (syllabus: "Lessons form a prerequisite DAG, not a
 * list") and the unlock computation behind
 * `progress.mastery.unlocked_lesson_ids` (system-design §5).
 *
 * Pure functions over plain data: the route layer loads the graph from the
 * fully-cached `catalog` schema and the user's completed set, and calls in here.
 */

export interface LessonNode {
  id: number;
  moduleId: number;
  kind: 'concept' | 'interactive' | 'lab' | 'drill' | 'checkpoint' | 'project';
  position: number;
  /** Hard prerequisites: every one must be completed before the lesson opens. */
  prereqs: number[];
  /** Soft prerequisites: they only influence recommendation order. */
  softPrereqs: number[];
  conceptIds: number[];
}

export interface UnlockInput {
  lessons: readonly LessonNode[];
  completed: Iterable<number>;
}

export interface UnlockResult {
  /** Lessons whose hard prerequisites are all satisfied and that are not done. */
  unlocked: number[];
  /** Lessons still blocked, with the specific prerequisites that block them. */
  blocked: Map<number, number[]>;
}

export class CyclicGraphError extends Error {
  readonly cycle: number[];
  constructor(cycle: number[]) {
    super(`Lesson prerequisite graph contains a cycle: ${cycle.join(' -> ')}`);
    this.name = 'CyclicGraphError';
    this.cycle = cycle;
  }
}

/**
 * Computes the unlocked frontier.
 *
 * Note that a completed lesson is *not* returned as unlocked: the array is the
 * answer to "what can I start now", which is exactly what the single-row read in
 * §5 is for.
 */
export function computeUnlocked(input: UnlockInput): UnlockResult {
  const completed = new Set(input.completed);
  const unlocked: number[] = [];
  const blocked = new Map<number, number[]>();

  for (const lesson of input.lessons) {
    if (completed.has(lesson.id)) continue;
    const missing = lesson.prereqs.filter((p) => !completed.has(p));
    if (missing.length === 0) {
      unlocked.push(lesson.id);
    } else {
      blocked.set(lesson.id, missing);
    }
  }

  unlocked.sort((a, b) => a - b);
  return { unlocked, blocked };
}

/**
 * Kahn's algorithm. Throws `CyclicGraphError` naming one member of a cycle, so
 * a bad seed or a bad admin edit fails loudly at load time rather than producing
 * a silently truncated ordering.
 */
export function topologicalOrder(lessons: readonly LessonNode[]): number[] {
  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  const byId = new Map<number, LessonNode>();

  for (const lesson of lessons) {
    byId.set(lesson.id, lesson);
    indegree.set(lesson.id, 0);
  }

  for (const lesson of lessons) {
    for (const prereq of lesson.prereqs) {
      if (!byId.has(prereq)) continue;
      indegree.set(lesson.id, (indegree.get(lesson.id) ?? 0) + 1);
      const list = dependents.get(prereq);
      if (list) list.push(lesson.id);
      else dependents.set(prereq, [lesson.id]);
    }
  }

  const queue: number[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }
  queue.sort((a, b) => a - b);

  const order: number[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== lessons.length) {
    const stuck = [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
    throw new CyclicGraphError(stuck.slice(0, 8));
  }

  return order;
}

/**
 * Every lesson reachable backwards from `lessonId` through hard edges — the
 * "what do I still have to do to get here" query behind a roadmap.
 */
export function transitivePrereqs(
  lessons: readonly LessonNode[],
  lessonId: number,
): Set<number> {
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const seen = new Set<number>();
  const stack = [...(byId.get(lessonId)?.prereqs ?? [])];

  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of byId.get(id)?.prereqs ?? []) {
      if (!seen.has(p)) stack.push(p);
    }
  }

  return seen;
}

export interface RecommendationInput {
  lessons: readonly LessonNode[];
  completed: Iterable<number>;
  /** Concept id -> mastery in [0, 1]. */
  conceptMastery: ReadonlyMap<number, number>;
  /** Syllabus: recommend only where every prerequisite concept exceeds this. */
  masteryThreshold?: number;
  limit?: number;
}

export interface Recommendation {
  lessonId: number;
  /** Mean mastery over the lesson's own concepts; the ranking key. */
  score: number;
  reason: 'weakest-concept' | 'next-in-module' | 'no-concept-data';
}

/**
 * The tutor's recommendation rule from the syllabus, verbatim:
 * `argmin(mastery)` over nodes whose prerequisites all exceed 0.7 — restricted,
 * as the syllabus also requires, to nodes whose prerequisites are satisfied.
 */
export function recommendNext(input: RecommendationInput): Recommendation[] {
  const threshold = input.masteryThreshold ?? 0.7;
  const limit = input.limit ?? 5;
  const { unlocked } = computeUnlocked({ lessons: input.lessons, completed: input.completed });
  const unlockedSet = new Set(unlocked);
  const byId = new Map(input.lessons.map((l) => [l.id, l]));

  const candidates: Recommendation[] = [];

  for (const lessonId of unlocked) {
    const lesson = byId.get(lessonId);
    if (!lesson) continue;

    // Every prerequisite lesson's concepts must be above the threshold. A
    // completed-but-not-understood prerequisite should not open the next node.
    const prereqConcepts = lesson.prereqs
      .flatMap((p) => byId.get(p)?.conceptIds ?? [])
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const prereqsUnderstood = prereqConcepts.every(
      (c) => (input.conceptMastery.get(c) ?? 0) >= threshold,
    );
    if (!prereqsUnderstood) continue;

    const own = lesson.conceptIds;
    if (own.length === 0) {
      candidates.push({ lessonId, score: 0.5, reason: 'no-concept-data' });
      continue;
    }

    const mean = own.reduce((sum, c) => sum + (input.conceptMastery.get(c) ?? 0), 0) / own.length;
    const sameModuleContinuation = lesson.prereqs.some(
      (p) => byId.get(p)?.moduleId === lesson.moduleId && !unlockedSet.has(p),
    );
    candidates.push({
      lessonId,
      score: mean,
      reason: sameModuleContinuation ? 'next-in-module' : 'weakest-concept',
    });
  }

  candidates.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const la = byId.get(a.lessonId);
    const lb = byId.get(b.lessonId);
    if (la && lb && la.moduleId !== lb.moduleId) return la.moduleId - lb.moduleId;
    if (la && lb && la.position !== lb.position) return la.position - lb.position;
    return a.lessonId - b.lessonId;
  });

  return candidates.slice(0, limit);
}

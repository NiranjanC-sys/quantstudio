/**
 * DAG unlock logic — the computation behind
 * `progress.mastery.unlocked_lesson_ids` (system-design §5) and the syllabus'
 * claim that "lessons form a prerequisite DAG, not a list".
 *
 * The graph used here is a small but genuinely non-linear one, because the
 * failure this guards against is a linear implementation that happens to work on
 * a chain: a diamond, a soft edge, and a checkpoint that gates a whole module.
 *
 *      1 ──▶ 2 ──▶ 4 ──▶ 5(checkpoint) ──▶ 6 ──▶ 7
 *      │           ▲                        ▲
 *      └────▶ 3 ───┘                 8 ┄┄┄┄┄┘  (8 → 6 is a *soft* edge)
 */
import { describe, expect, it } from 'vitest';
import {
  computeUnlocked,
  CyclicGraphError,
  recommendNext,
  topologicalOrder,
  transitivePrereqs,
  type LessonNode,
} from '../../src/lib/dag.js';

function node(
  id: number,
  prereqs: number[],
  options: Partial<LessonNode> = {},
): LessonNode {
  return {
    id,
    moduleId: options.moduleId ?? 1,
    kind: options.kind ?? 'concept',
    position: options.position ?? id,
    prereqs,
    softPrereqs: options.softPrereqs ?? [],
    conceptIds: options.conceptIds ?? [],
  };
}

const GRAPH: LessonNode[] = [
  node(1, [], { conceptIds: [10] }),
  node(2, [1], { conceptIds: [10] }),
  node(3, [1], { conceptIds: [11] }),
  node(4, [2, 3], { conceptIds: [12] }),
  node(5, [4], { kind: 'checkpoint', conceptIds: [10, 11, 12] }),
  node(6, [5], { moduleId: 2, conceptIds: [13], softPrereqs: [8] }),
  node(7, [6], { moduleId: 2, conceptIds: [13] }),
  node(8, [], { moduleId: 3, conceptIds: [14] }),
];

describe('computeUnlocked', () => {
  it('opens only the roots for a learner who has done nothing', () => {
    const { unlocked, blocked } = computeUnlocked({ lessons: GRAPH, completed: [] });

    expect(unlocked).toEqual([1, 8]);
    expect(blocked.get(4)).toEqual([2, 3]);
    expect(blocked.get(6)).toEqual([5]);
  });

  it('opens both branches of a diamond after the shared root', () => {
    const { unlocked } = computeUnlocked({ lessons: GRAPH, completed: [1] });
    expect(unlocked).toEqual([2, 3, 8]);
  });

  it('keeps a join blocked until every branch is done', () => {
    const partial = computeUnlocked({ lessons: GRAPH, completed: [1, 2] });
    expect(partial.unlocked).not.toContain(4);
    expect(partial.blocked.get(4)).toEqual([3]);

    const complete = computeUnlocked({ lessons: GRAPH, completed: [1, 2, 3] });
    expect(complete.unlocked).toContain(4);
  });

  it('treats a checkpoint as the gate on the next module', () => {
    const beforeCheckpoint = computeUnlocked({ lessons: GRAPH, completed: [1, 2, 3, 4] });
    expect(beforeCheckpoint.unlocked).toContain(5);
    expect(beforeCheckpoint.unlocked).not.toContain(6);

    const afterCheckpoint = computeUnlocked({ lessons: GRAPH, completed: [1, 2, 3, 4, 5] });
    expect(afterCheckpoint.unlocked).toContain(6);
  });

  it('ignores soft edges when deciding what is open', () => {
    // Lesson 6 soft-depends on 8, which has not been done; it still unlocks.
    const { unlocked } = computeUnlocked({ lessons: GRAPH, completed: [1, 2, 3, 4, 5] });
    expect(unlocked).toContain(6);
  });

  it('never reports a completed lesson as unlocked', () => {
    const { unlocked } = computeUnlocked({ lessons: GRAPH, completed: [1, 2, 3] });
    for (const done of [1, 2, 3]) expect(unlocked).not.toContain(done);
  });

  it('returns a sorted, deterministic array, whatever order the input is in', () => {
    const shuffled = [...GRAPH].reverse();
    const a = computeUnlocked({ lessons: GRAPH, completed: [1] });
    const b = computeUnlocked({ lessons: shuffled, completed: [1] });
    expect(a.unlocked).toEqual(b.unlocked);
    expect([...a.unlocked]).toEqual([...a.unlocked].sort((x, y) => x - y));
  });

  it('empties the frontier once everything is complete', () => {
    const { unlocked } = computeUnlocked({
      lessons: GRAPH,
      completed: GRAPH.map((lesson) => lesson.id),
    });
    expect(unlocked).toEqual([]);
  });

  it('ignores a completed id that is not in the graph', () => {
    const { unlocked } = computeUnlocked({ lessons: GRAPH, completed: [1, 999] });
    expect(unlocked).toEqual([2, 3, 8]);
  });
});

describe('topologicalOrder', () => {
  it('emits every prerequisite before the lesson that needs it', () => {
    const order = topologicalOrder(GRAPH);
    expect(order).toHaveLength(GRAPH.length);

    const position = new Map(order.map((id, index) => [id, index]));
    for (const lesson of GRAPH) {
      for (const prereq of lesson.prereqs) {
        expect(position.get(prereq) as number).toBeLessThan(position.get(lesson.id) as number);
      }
    }
  });

  it('throws a named error on a cycle rather than truncating silently', () => {
    const cyclic = [node(1, [3]), node(2, [1]), node(3, [2])];
    expect(() => topologicalOrder(cyclic)).toThrow(CyclicGraphError);

    try {
      topologicalOrder(cyclic);
      expect.unreachable('topologicalOrder should have thrown');
    } catch (error) {
      expect((error as CyclicGraphError).cycle.length).toBeGreaterThan(0);
    }
  });

  it('tolerates an edge pointing outside the supplied subgraph', () => {
    const subgraph = [node(20, [999]), node(21, [20])];
    expect(topologicalOrder(subgraph)).toEqual([20, 21]);
  });
});

describe('transitivePrereqs', () => {
  it('collects everything reachable backwards through hard edges', () => {
    expect([...transitivePrereqs(GRAPH, 7)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...transitivePrereqs(GRAPH, 4)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...transitivePrereqs(GRAPH, 1)]).toEqual([]);
  });
});

describe('recommendNext', () => {
  it('recommends the weakest unlocked node whose prerequisites are understood', () => {
    const conceptMastery = new Map([
      [10, 0.95],
      [11, 0.9],
      [12, 0.2],
      [13, 0.5],
      [14, 0.8],
    ]);

    const recommendations = recommendNext({
      lessons: GRAPH,
      completed: [1, 2, 3],
      conceptMastery,
    });

    // Both 4 and 8 are unlocked. 4's prerequisite concepts (10, 11) are above
    // the 0.7 threshold and its own concept (12) sits at 0.2 against 8's 0.8, so
    // `argmin(mastery)` puts 4 first — the syllabus' rule, exactly.
    expect(recommendations.map((r) => r.lessonId)).toEqual([4, 8]);
    expect(recommendations[0]?.score).toBeCloseTo(0.2, 6);
  });

  it('refuses to recommend past a prerequisite the learner has not understood', () => {
    // Lesson 3's concept sits below the 0.7 threshold, so 4 is completed-but-not
    // -understood territory and must not be recommended.
    const conceptMastery = new Map([
      [10, 0.95],
      [11, 0.3],
      [12, 0.1],
      [14, 0.9],
    ]);

    const recommendations = recommendNext({
      lessons: GRAPH,
      completed: [1, 2, 3],
      conceptMastery,
    });

    expect(recommendations.map((r) => r.lessonId)).not.toContain(4);
  });

  it('honours the limit and never recommends a locked lesson', () => {
    const recommendations = recommendNext({
      lessons: GRAPH,
      completed: [],
      conceptMastery: new Map(),
      limit: 1,
    });

    expect(recommendations).toHaveLength(1);
    expect([1, 8]).toContain(recommendations[0]?.lessonId);
  });

  it('labels a lesson with no concept data instead of scoring it zero', () => {
    const recommendations = recommendNext({
      lessons: [node(30, []), node(31, [30])],
      completed: [],
      conceptMastery: new Map(),
    });

    expect(recommendations[0]?.reason).toBe('no-concept-data');
    expect(recommendations[0]?.score).toBe(0.5);
  });
});

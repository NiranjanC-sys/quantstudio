import { describe, expect, it } from 'vitest';

import { DAG_NODES, LESSONS, getLesson } from '../src/catalog.js';
import {
  DagError,
  ancestorsOf,
  criticalPath,
  danglingPrerequisites,
  descendantsOf,
  findCycle,
  isAcyclic,
  nextBest,
  pathTo,
  topologicalSort,
  unlockedGiven,
} from '../src/dag.js';

describe('the prerequisite graph', () => {
  it('has no dangling prerequisites', () => {
    expect(danglingPrerequisites(DAG_NODES)).toEqual([]);
  });

  it('is acyclic', () => {
    expect(findCycle(DAG_NODES)).toBeNull();
    expect(isAcyclic(DAG_NODES)).toBe(true);
  });

  it('topologically sorts every lesson exactly once', () => {
    const order = topologicalSort(DAG_NODES);
    expect(order.length).toBe(LESSONS.length);
    expect(new Set(order).size).toBe(order.length);
  });

  it('places every lesson after all of its prerequisites', () => {
    const order = topologicalSort(DAG_NODES);
    const position = new Map(order.map((id, i) => [id, i]));
    const violations: string[] = [];
    for (const lesson of LESSONS) {
      for (const p of lesson.prerequisites) {
        if (position.get(p)! >= position.get(lesson.id)!) violations.push(`${p} -> ${lesson.id}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('only ever points backwards through the track ordering', () => {
    const rank = (id: string) => {
      const [t, m, l] = id.split('.');
      return [Number(t!.slice(1)), Number(m!.slice(1)), Number(l!.slice(1))] as const;
    };
    const violations: string[] = [];
    for (const lesson of LESSONS) {
      const [lt, lm, ll] = rank(lesson.id);
      for (const p of lesson.prerequisites) {
        const [pt, pm, pl] = rank(p);
        const backwards = pt < lt || (pt === lt && (pm < lm || (pm === lm && pl < ll)));
        if (!backwards) violations.push(`${lesson.id} requires ${p}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('has at least one entry point with no prerequisites', () => {
    expect(LESSONS.filter((l) => l.prerequisites.length === 0).length).toBeGreaterThan(0);
  });

  it('leaves no unreachable island in the middle of a track', () => {
    // Every lesson beyond the first of its module either has a prerequisite or
    // is an entry point of its track.
    const orphans = LESSONS.filter(
      (l) => l.prerequisites.length === 0 && !l.id.endsWith('.l1'),
    ).map((l) => l.id);
    expect(orphans).toEqual([]);
  });

  it('reports ancestors and descendants consistently', () => {
    const target = 't1.m10.l4';
    const ancestors = ancestorsOf(DAG_NODES, target);
    expect(ancestors).toContain('t1.m10.l1');
    for (const a of ancestors) {
      expect(descendantsOf(DAG_NODES, a)).toContain(target);
    }
  });

  it('computes a critical path that is itself a prerequisite chain', () => {
    const path = criticalPath(DAG_NODES);
    expect(path.length).toBeGreaterThan(5);
    for (let i = 1; i < path.length; i += 1) {
      expect(getLesson(path[i]!)!.prerequisites).toContain(path[i - 1]!);
    }
  });
});

describe('unlocking and recommendation', () => {
  it('unlocks only the entry points when nothing is mastered', () => {
    const unlocked = unlockedGiven(DAG_NODES, {});
    const entries = LESSONS.filter((l) => l.prerequisites.length === 0).map((l) => l.id).sort();
    expect(unlocked).toEqual(entries);
  });

  it('unlocks a lesson once every prerequisite passes the threshold', () => {
    const lesson = getLesson('t1.m1.l2')!;
    const partial: Record<string, number> = {};
    for (const p of lesson.prerequisites) partial[p] = 0.69;
    expect(unlockedGiven(DAG_NODES, partial)).not.toContain(lesson.id);
    for (const p of lesson.prerequisites) partial[p] = 0.71;
    expect(unlockedGiven(DAG_NODES, partial)).toContain(lesson.id);
  });

  it('never recommends a node whose prerequisites are unmet', () => {
    const mastery: Record<string, number> = {};
    for (const l of LESSONS.slice(0, 40)) mastery[l.id] = 0.9;
    const pick = nextBest(DAG_NODES, mastery);
    expect(pick).not.toBeNull();
    const node = getLesson(pick!)!;
    for (const p of node.prerequisites) expect(mastery[p] ?? 0).toBeGreaterThanOrEqual(0.7);
  });

  it('recommends the weakest unlocked node', () => {
    const mastery: Record<string, number> = {};
    const entries = LESSONS.filter((l) => l.prerequisites.length === 0);
    for (const [i, l] of entries.entries()) mastery[l.id] = 0.1 * ((i % 5) + 1);
    const weakest = entries
      .slice()
      .sort((a, b) => (mastery[a.id]! - mastery[b.id]!) || a.id.localeCompare(b.id))[0]!;
    expect(nextBest(DAG_NODES, mastery)).toBe(weakest.id);
  });

  it('returns null once everything is mastered', () => {
    const mastery: Record<string, number> = {};
    for (const l of LESSONS) mastery[l.id] = 1;
    expect(nextBest(DAG_NODES, mastery)).toBeNull();
  });

  it('honours a restriction set', () => {
    const allow = ['t0.m1.l1'];
    expect(nextBest(DAG_NODES, {}, { restrictTo: allow })).toBe('t0.m1.l1');
  });

  it('builds a prerequisite-closed, topologically ordered path to a target', () => {
    const path = pathTo(DAG_NODES, 't1.m12.l1');
    expect(path[path.length - 1]).toBe('t1.m12.l1');
    const included = new Set(path);
    for (const id of path) {
      for (const p of getLesson(id)!.prerequisites) expect(included.has(p)).toBe(true);
    }
    const position = new Map(path.map((id, i) => [id, i]));
    for (const id of path) {
      for (const p of getLesson(id)!.prerequisites) {
        expect(position.get(p)!).toBeLessThan(position.get(id)!);
      }
    }
  });

  it('skips already-mastered prerequisites when planning a path', () => {
    const full = pathTo(DAG_NODES, 't1.m12.l1');
    const mastery: Record<string, number> = {};
    for (const id of full.slice(0, 10)) mastery[id] = 1;
    const shorter = pathTo(DAG_NODES, 't1.m12.l1', mastery);
    expect(shorter.length).toBeLessThan(full.length);
  });
});

describe('graph utilities in isolation', () => {
  it('detects a cycle', () => {
    const nodes = [
      { id: 'a', prerequisites: ['c'] },
      { id: 'b', prerequisites: ['a'] },
      { id: 'c', prerequisites: ['b'] },
    ];
    const cycle = findCycle(nodes);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThan(1);
    expect(() => topologicalSort(nodes)).toThrow(DagError);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      topologicalSort([
        { id: 'a', prerequisites: [] },
        { id: 'a', prerequisites: [] },
      ]),
    ).toThrow(DagError);
  });

  it('reports a dangling edge without throwing', () => {
    expect(danglingPrerequisites([{ id: 'a', prerequisites: ['missing'] }])).toEqual([
      'a -> missing',
    ]);
  });
});

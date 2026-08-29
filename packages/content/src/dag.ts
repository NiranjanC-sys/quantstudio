/**
 * Graph utilities over the lesson prerequisite DAG.
 *
 * The DAG, not the track list, is the source of truth for what a learner may
 * study next. Every function here is pure and takes the node set explicitly so
 * that the tutor can reason about hypothetical graphs (a placement test result,
 * a roadmap subgraph) without mutating the catalogue.
 */

export interface DagNode {
  id: string;
  prerequisites: string[];
}

export type MasteryMap = Readonly<Record<string, number>>;

/** A node counts as mastered for gating purposes at or above this value. */
export const MASTERY_THRESHOLD = 0.7;

export class DagError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'DagError';
  }
}

function indexById<T extends DagNode>(nodes: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const n of nodes) {
    if (m.has(n.id)) throw new DagError(`duplicate node id '${n.id}'`);
    m.set(n.id, n);
  }
  return m;
}

/** Prerequisite ids that no node supplies. Empty means the graph is closed. */
export function danglingPrerequisites<T extends DagNode>(nodes: readonly T[]): string[] {
  const known = new Set(nodes.map((n) => n.id));
  const missing = new Set<string>();
  for (const n of nodes) {
    for (const p of n.prerequisites) if (!known.has(p)) missing.add(`${n.id} -> ${p}`);
  }
  return [...missing].sort();
}

/**
 * Kahn's algorithm. Returns an order in which every node follows all of its
 * prerequisites. Ties break on id so the output is deterministic and diffable.
 */
export function topologicalSort<T extends DagNode>(nodes: readonly T[]): string[] {
  const byId = indexById(nodes);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const n of nodes) {
    indegree.set(n.id, 0);
    dependents.set(n.id, []);
  }
  for (const n of nodes) {
    for (const p of n.prerequisites) {
      if (!byId.has(p)) throw new DagError(`node '${n.id}' requires unknown node '${p}'`);
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      dependents.get(p)!.push(n.id);
    }
  }

  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const d of dependents.get(id)!.sort()) {
      const next = (indegree.get(d) ?? 0) - 1;
      indegree.set(d, next);
      if (next === 0) {
        // Keep `ready` sorted so the result is stable.
        const at = ready.findIndex((x) => x > d);
        if (at === -1) ready.push(d);
        else ready.splice(at, 0, d);
      }
    }
  }

  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    throw new DagError(`graph contains a cycle among ${stuck.length} nodes`, stuck);
  }
  return order;
}

/**
 * The first cycle found, as a list of ids beginning and ending at the same node,
 * or `null` when the graph is acyclic. Uses an explicit stack so a deep graph
 * cannot blow the call stack.
 */
export function findCycle<T extends DagNode>(nodes: readonly T[]): string[] | null {
  const byId = indexById(nodes);
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on stack, 2 done
  for (const n of nodes) state.set(n.id, 0);

  for (const root of [...byId.keys()].sort()) {
    if (state.get(root) !== 0) continue;
    const path: string[] = [];
    const stack: Array<{ id: string; i: number }> = [{ id: root, i: 0 }];
    state.set(root, 1);
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const node = byId.get(frame.id);
      const prereqs = node ? node.prerequisites : [];
      if (frame.i < prereqs.length) {
        const p = prereqs[frame.i]!;
        frame.i += 1;
        if (!byId.has(p)) continue; // dangling edges are a separate check
        const s = state.get(p);
        if (s === 1) return [...path.slice(path.indexOf(p)), p];
        if (s === 0) {
          state.set(p, 1);
          path.push(p);
          stack.push({ id: p, i: 0 });
        }
      } else {
        state.set(frame.id, 2);
        stack.pop();
        path.pop();
      }
    }
  }
  return null;
}

export function isAcyclic<T extends DagNode>(nodes: readonly T[]): boolean {
  return findCycle(nodes) === null;
}

/** Every node reachable by walking prerequisites upward from `id`. */
export function ancestorsOf<T extends DagNode>(nodes: readonly T[], id: string): string[] {
  const byId = indexById(nodes);
  if (!byId.has(id)) throw new DagError(`unknown node '${id}'`);
  const seen = new Set<string>();
  const stack = [...(byId.get(id)!.prerequisites)];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = byId.get(cur);
    if (node) stack.push(...node.prerequisites);
  }
  return [...seen].sort();
}

/** Every node that transitively depends on `id`. */
export function descendantsOf<T extends DagNode>(nodes: readonly T[], id: string): string[] {
  const dependents = new Map<string, string[]>();
  for (const n of nodes) dependents.set(n.id, []);
  for (const n of nodes) for (const p of n.prerequisites) dependents.get(p)?.push(n.id);

  const seen = new Set<string>();
  const stack = [...(dependents.get(id) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(dependents.get(cur) ?? []));
  }
  return [...seen].sort();
}

function mastery(map: MasteryMap, id: string): number {
  const v = map[id];
  return typeof v === 'number' ? v : 0;
}

export function isSatisfied<T extends DagNode>(node: T, map: MasteryMap, threshold = MASTERY_THRESHOLD): boolean {
  return node.prerequisites.every((p) => mastery(map, p) >= threshold);
}

/**
 * Nodes the learner may start now: every prerequisite is above threshold and the
 * node itself is not yet mastered. This is the only set the tutor may recommend
 * from.
 */
export function unlockedGiven<T extends DagNode>(
  nodes: readonly T[],
  map: MasteryMap,
  threshold = MASTERY_THRESHOLD,
): string[] {
  return nodes
    .filter((n) => mastery(map, n.id) < threshold && isSatisfied(n, map, threshold))
    .map((n) => n.id)
    .sort();
}

export interface NextBestOptions {
  threshold?: number;
  /** Restrict the recommendation to a roadmap or track subset. */
  restrictTo?: readonly string[];
  /** Deterministic tie-break order; defaults to catalogue order. */
  order?: readonly string[];
}

/**
 * `argmin(mastery)` over unlocked nodes, matching the syllabus mastery model.
 * Ties break by the supplied order, then by id, so the tutor never oscillates
 * between two equally weak nodes.
 */
export function nextBest<T extends DagNode>(
  nodes: readonly T[],
  map: MasteryMap,
  options: NextBestOptions = {},
): string | null {
  const threshold = options.threshold ?? MASTERY_THRESHOLD;
  const allow = options.restrictTo ? new Set(options.restrictTo) : null;
  const rank = new Map<string, number>();
  const order = options.order ?? nodes.map((n) => n.id);
  order.forEach((id, i) => rank.set(id, i));

  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const id of unlockedGiven(nodes, map, threshold)) {
    if (allow && !allow.has(id)) continue;
    const score = mastery(map, id);
    const r = rank.get(id) ?? Number.MAX_SAFE_INTEGER;
    if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && r < bestRank)) {
      best = id;
      bestScore = score;
      bestRank = r;
    }
  }
  return best;
}

/**
 * The shortest prerequisite-closed set of nodes that must be completed to reach
 * `target`, given current mastery. Returned in topological order, so it is a
 * runnable plan.
 */
export function pathTo<T extends DagNode>(
  nodes: readonly T[],
  target: string,
  map: MasteryMap = {},
  threshold = MASTERY_THRESHOLD,
): string[] {
  const byId = indexById(nodes);
  if (!byId.has(target)) throw new DagError(`unknown node '${target}'`);
  const need = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (need.has(cur)) continue;
    if (cur !== target && mastery(map, cur) >= threshold) continue;
    need.add(cur);
    for (const p of byId.get(cur)?.prerequisites ?? []) stack.push(p);
  }
  const sub = nodes.filter((n) => need.has(n.id)).map((n) => ({
    id: n.id,
    prerequisites: n.prerequisites.filter((p) => need.has(p)),
  }));
  return topologicalSort(sub);
}

/** Longest chain of prerequisites in the graph, a proxy for curriculum depth. */
export function criticalPath<T extends DagNode>(nodes: readonly T[]): string[] {
  const byId = indexById(nodes);
  const order = topologicalSort(nodes);
  const best = new Map<string, { len: number; prev: string | null }>();
  for (const id of order) {
    let acc = { len: 1, prev: null as string | null };
    for (const p of byId.get(id)!.prerequisites) {
      const cand = (best.get(p)?.len ?? 0) + 1;
      if (cand > acc.len) acc = { len: cand, prev: p };
    }
    best.set(id, acc);
  }
  let tail: string | null = null;
  let max = 0;
  for (const [id, v] of best) if (v.len > max) { max = v.len; tail = id; }
  const path: string[] = [];
  while (tail) {
    path.push(tail);
    tail = best.get(tail)?.prev ?? null;
  }
  return path.reverse();
}

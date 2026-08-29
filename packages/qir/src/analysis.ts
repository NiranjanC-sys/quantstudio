/**
 * Circuit analysis: the numbers the builder shows in its status bar, the
 * autograder scores against, and the transpiler lesson compares before and
 * after.
 */

import { GATES, gate } from './gates.js';
import { type Circuit, type Op, opQubits } from './types.js';

/**
 * Whether an op lands in the Clifford group once its controls are counted.
 *
 * Adding controls does not preserve Clifford membership. CX, CY and CZ are
 * Clifford, but CCX (Toffoli) and CCZ are not, and neither is CH, CS or
 * CSWAP. Getting this wrong makes the builder claim a circuit is classically
 * simulable when it is exactly the circuit that is not.
 */
export function isCliffordOp(op: Op): boolean {
  const def = GATES[op.gate];
  if (!def || !def.clifford) return false;
  const controls = op.controls?.length ?? 0;
  if (controls === 0) return true;
  if (controls === 1) return op.gate === 'x' || op.gate === 'y' || op.gate === 'z';
  return false;
}

export interface CircuitMetrics {
  qubits: number;
  clbits: number;
  /** Total ops, barriers excluded. */
  size: number;
  /** Longest path through the dependency graph, barriers excluded. */
  depth: number;
  /** Ops acting on exactly two qubits (controls included). */
  twoQubitGates: number;
  /** Ops acting on three or more qubits. */
  multiQubitGates: number;
  singleQubitGates: number;
  measurements: number;
  /** T and T-dagger count. The dominant cost under error correction. */
  tCount: number;
  /** True when every op is in the Clifford group, so it is classically simulable. */
  clifford: boolean;
  gateCounts: Record<string, number>;
  /** Number of qubits actually touched. */
  activeQubits: number;
}

/** ASAP layering. Layer index per op; barriers act as a full-width fence. */
export function layerize(circuit: Circuit): number[] {
  const frontier = new Array<number>(circuit.qubits).fill(0);
  const clFrontier = new Array<number>(Math.max(circuit.clbits, 1)).fill(0);
  const layers: number[] = [];
  for (const op of circuit.ops) {
    if (op.gate === 'barrier') {
      const max = Math.max(0, ...frontier);
      frontier.fill(max);
      layers.push(max);
      continue;
    }
    const qs = opQubits(op);
    let layer = 0;
    for (const q of qs) layer = Math.max(layer, frontier[q] ?? 0);
    for (const c of op.cbits ?? []) layer = Math.max(layer, clFrontier[c] ?? 0);
    for (const c of op.condition?.bits ?? []) layer = Math.max(layer, clFrontier[c] ?? 0);
    layers.push(layer);
    for (const q of qs) frontier[q] = layer + 1;
    for (const c of op.cbits ?? []) clFrontier[c] = layer + 1;
  }
  return layers;
}

/** Ops grouped into visual columns for the builder canvas. */
export function moments(circuit: Circuit): Op[][] {
  const layers = layerize(circuit);
  const out: Op[][] = [];
  circuit.ops.forEach((op, i) => {
    const l = layers[i]!;
    (out[l] ??= []).push(op);
  });
  for (let i = 0; i < out.length; i++) out[i] ??= [];
  return out;
}

export function metrics(circuit: Circuit): CircuitMetrics {
  const gateCounts: Record<string, number> = {};
  let size = 0;
  let one = 0;
  let two = 0;
  let multi = 0;
  let meas = 0;
  let tCount = 0;
  let clifford = true;
  const touched = new Set<number>();

  for (const op of circuit.ops) {
    gateCounts[op.gate] = (gateCounts[op.gate] ?? 0) + 1;
    if (op.gate === 'barrier') continue;
    size++;
    const qs = opQubits(op);
    qs.forEach((q) => touched.add(q));
    if (op.gate === 'measure') meas++;
    else if (qs.length === 1) one++;
    else if (qs.length === 2) two++;
    else multi++;
    if (op.gate === 't' || op.gate === 'tdg') tCount++;
    if (!isCliffordOp(op)) clifford = false;
  }

  const layers = layerize(circuit);
  const depth = circuit.ops.length
    ? Math.max(
        0,
        ...circuit.ops.map((op, i) => (op.gate === 'barrier' ? 0 : (layers[i] ?? 0) + 1)),
      )
    : 0;

  return {
    qubits: circuit.qubits,
    clbits: circuit.clbits,
    size,
    depth,
    twoQubitGates: two,
    multiQubitGates: multi,
    singleQubitGates: one,
    measurements: meas,
    tCount,
    clifford,
    gateCounts,
    activeQubits: touched.size,
  };
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  opId?: string;
}

/** Structural validation. Runs on every edit so the builder can never save junk. */
export function validate(circuit: Circuit): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (circuit.qubits < 1) issues.push({ severity: 'error', message: 'circuit needs at least one qubit' });

  for (const op of circuit.ops) {
    const def = GATES[op.gate];
    if (!def) {
      issues.push({ severity: 'error', message: `unknown gate '${op.gate}'`, opId: op.id });
      continue;
    }
    const qs = opQubits(op);
    for (const q of qs) {
      if (q < 0 || q >= circuit.qubits) {
        issues.push({ severity: 'error', message: `${op.gate} references qubit ${q}, out of range`, opId: op.id });
      }
    }
    if (new Set(qs).size !== qs.length) {
      issues.push({ severity: 'error', message: `${op.gate} uses the same qubit twice`, opId: op.id });
    }
    // A barrier legitimately spans any number of wires, so its arity of 1 is a
    // display default rather than a constraint.
    const freeArity = op.gate === 'barrier' || (def.controlledForm && def.controlledForm.controls < 0);
    const expectedTargets = freeArity ? op.targets.length : def.arity;
    if (op.targets.length !== expectedTargets) {
      issues.push({
        severity: 'error',
        message: `${op.gate} expects ${expectedTargets} target(s), got ${op.targets.length}`,
        opId: op.id,
      });
    }
    const np = def.paramNames.length;
    if ((op.params?.length ?? 0) !== np) {
      issues.push({
        severity: 'error',
        message: `${op.gate} expects ${np} parameter(s) (${def.paramNames.join(', ') || 'none'}), got ${op.params?.length ?? 0}`,
        opId: op.id,
      });
    }
    if (op.gate === 'measure') {
      const cb = op.cbits?.[0];
      if (cb === undefined) issues.push({ severity: 'error', message: 'measure needs a classical bit', opId: op.id });
      else if (cb >= circuit.clbits) issues.push({ severity: 'error', message: `classical bit ${cb} out of range`, opId: op.id });
    }
  }

  const m = metrics(circuit);
  if (m.activeQubits < circuit.qubits) {
    issues.push({
      severity: 'warning',
      message: `${circuit.qubits - m.activeQubits} qubit(s) are never used`,
    });
  }
  return issues;
}

/** The circuit that undoes this one. Fails loudly on non-unitary ops. */
export function inverse(circuit: Circuit): Circuit {
  const ops: Op[] = [];
  for (let i = circuit.ops.length - 1; i >= 0; i--) {
    const op = circuit.ops[i]!;
    if (op.gate === 'barrier') {
      ops.push({ ...op, id: `${op.id}-inv` });
      continue;
    }
    const def = gate(op.gate);
    if (!def.inverse) throw new Error(`gate '${op.gate}' has no defined inverse`);
    const params = op.params?.map((p) => (typeof p === 'number' ? p : 0)) ?? [];
    const newParams = def.inverse.params ? def.inverse.params(params) : op.params;
    ops.push({
      ...op,
      id: `${op.id}-inv`,
      gate: def.inverse.gate,
      params: Array.isArray(newParams) ? (newParams as Op['params']) : op.params,
    });
  }
  return { ...circuit, name: `${circuit.name}-inverse`, ops };
}

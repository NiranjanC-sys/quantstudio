/**
 * RedQuant Circuit IR, version 1.
 *
 * One canonical representation shared by the drag-and-drop builder, the four
 * code dialects, the browser simulator, and the Python kernel. Anything that
 * can be expressed in the builder can be expressed here, round-tripped to any
 * dialect, and hashed for cache lookup.
 *
 * Ops are stored in a flat ordered list. Layers (the visual columns of the
 * builder) are *derived* by ASAP scheduling, never stored, so that an edit
 * cannot leave layer metadata inconsistent with semantics.
 */

export const IR_VERSION = 1 as const;

/** Qubit ordering. Qiskit and Cirq disagree; we are explicit and convert. */
export type BitOrder = 'little' | 'big';

/** A gate parameter: a literal angle in radians, or a named symbol. */
export type Param = number | { symbol: string };

export interface ClassicalCondition {
  /** Classical bit indices, least significant first. */
  bits: number[];
  /** Required integer value of those bits. */
  value: number;
}

export interface Op {
  /** Stable id, used by the editor for selection and undo. */
  id: string;
  /** Registry key, e.g. 'h', 'cx', 'rz', 'measure'. */
  gate: string;
  /** Target qubit indices, in operand order. */
  targets: number[];
  /** Positive control qubits. Empty or omitted for uncontrolled gates. */
  controls?: number[];
  /** Parameters in the order declared by the gate definition. */
  params?: Param[];
  /** Classical bit targets, for measure. */
  cbits?: number[];
  /** Classical control: execute only if the condition holds. */
  condition?: ClassicalCondition;
  /** Optional display label, e.g. for a boxed subroutine. */
  label?: string;
}

export interface Circuit {
  version: typeof IR_VERSION;
  name: string;
  qubits: number;
  clbits: number;
  ops: Op[];
  /** Free-form; never affects semantics or the canonical hash. */
  metadata?: Record<string, unknown>;
}

export function emptyCircuit(qubits = 2, clbits = qubits, name = 'circuit'): Circuit {
  return { version: IR_VERSION, name, qubits, clbits, ops: [] };
}

export function isSymbolic(p: Param | undefined): p is { symbol: string } {
  return typeof p === 'object' && p !== null && 'symbol' in p;
}

/** All qubits an op touches, controls included. */
export function opQubits(op: Op): number[] {
  return op.controls && op.controls.length ? [...op.controls, ...op.targets] : op.targets;
}

export function resolveParams(
  params: Param[] | undefined,
  bindings: Record<string, number> = {},
): number[] {
  if (!params) return [];
  return params.map((p) => {
    if (!isSymbolic(p)) return p;
    const v = bindings[p.symbol];
    if (v === undefined) throw new IRError(`unbound parameter '${p.symbol}'`);
    return v;
  });
}

export class IRError extends Error {
  constructor(message: string, readonly opId?: string) {
    super(message);
    this.name = 'IRError';
  }
}

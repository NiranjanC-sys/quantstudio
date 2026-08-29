/**
 * Immutable edit operations for the drag-and-drop builder.
 *
 * Every function returns a new Circuit. The editor keeps an undo stack of
 * Circuits rather than of diffs, which is affordable because a circuit is small
 * and makes undo trivially correct.
 */

import { gate, GATES } from './gates.js';
import { layerize } from './analysis.js';
import { type Circuit, type Op, type Param } from './types.js';

let idCounter = 0;
export function newOpId(): string {
  idCounter += 1;
  return `op_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export interface PlaceRequest {
  gate: string;
  targets: number[];
  controls?: number[];
  params?: Param[];
  cbits?: number[];
  /** Visual column to insert at. Omit to append. */
  layer?: number;
}

/** Default parameters for a freshly dropped gate, so it is never invalid. */
export function defaultParams(gateKey: string): Param[] {
  const def = gate(gateKey);
  return def.paramNames.map((n) => (n === 'theta' ? Math.PI / 2 : n === 'lambda' ? Math.PI / 4 : 0));
}

export function place(circuit: Circuit, req: PlaceRequest): Circuit {
  const op: Op = {
    id: newOpId(),
    gate: req.gate,
    targets: req.targets,
    ...(req.controls?.length ? { controls: req.controls } : {}),
    ...(req.params?.length ? { params: req.params } : GATES[req.gate]?.paramNames.length ? { params: defaultParams(req.gate) } : {}),
    ...(req.cbits?.length ? { cbits: req.cbits } : req.gate === 'measure' ? { cbits: [req.targets[0]!] } : {}),
  };
  if (req.layer === undefined) {
    return { ...circuit, ops: [...circuit.ops, op] };
  }
  const layers = layerize(circuit);
  const insertAt = layers.findIndex((l) => l >= req.layer!);
  const idx = insertAt === -1 ? circuit.ops.length : insertAt;
  const ops = [...circuit.ops.slice(0, idx), op, ...circuit.ops.slice(idx)];
  return { ...circuit, ops };
}

export function removeOp(circuit: Circuit, opId: string): Circuit {
  return { ...circuit, ops: circuit.ops.filter((o) => o.id !== opId) };
}

export function updateOp(circuit: Circuit, opId: string, patch: Partial<Op>): Circuit {
  return { ...circuit, ops: circuit.ops.map((o) => (o.id === opId ? { ...o, ...patch, id: o.id } : o)) };
}

export function moveOp(circuit: Circuit, opId: string, toIndex: number): Circuit {
  const idx = circuit.ops.findIndex((o) => o.id === opId);
  if (idx === -1) return circuit;
  const ops = [...circuit.ops];
  const [op] = ops.splice(idx, 1);
  ops.splice(Math.max(0, Math.min(toIndex, ops.length)), 0, op!);
  return { ...circuit, ops };
}

export function setQubits(circuit: Circuit, qubits: number): Circuit {
  const clamped = Math.max(1, Math.min(qubits, 32));
  const ops = circuit.ops.filter((o) =>
    [...(o.controls ?? []), ...o.targets].every((q) => q < clamped),
  );
  return { ...circuit, qubits: clamped, ops };
}

export function setClbits(circuit: Circuit, clbits: number): Circuit {
  const clamped = Math.max(0, Math.min(clbits, 32));
  const ops = circuit.ops.filter((o) => (o.cbits ?? []).every((c) => c < clamped));
  return { ...circuit, clbits: clamped, ops };
}

/** Add a control to an existing gate, the drag-a-dot-onto-a-wire interaction. */
export function addControl(circuit: Circuit, opId: string, qubit: number): Circuit {
  const op = circuit.ops.find((o) => o.id === opId);
  if (!op) return circuit;
  if (op.targets.includes(qubit) || op.controls?.includes(qubit)) return circuit;
  if (GATES[op.gate]?.category === 'nonunitary') return circuit;
  return updateOp(circuit, opId, { controls: [...(op.controls ?? []), qubit].sort((a, b) => a - b) });
}

export function removeControl(circuit: Circuit, opId: string, qubit: number): Circuit {
  const op = circuit.ops.find((o) => o.id === opId);
  if (!op?.controls) return circuit;
  return updateOp(circuit, opId, { controls: op.controls.filter((c) => c !== qubit) });
}

/** Append a whole sub-circuit, remapping its qubits onto the parent. */
export function appendCircuit(circuit: Circuit, sub: Circuit, qubitMap: number[]): Circuit {
  const ops = sub.ops.map((o) => ({
    ...o,
    id: newOpId(),
    targets: o.targets.map((q) => qubitMap[q] ?? q),
    ...(o.controls ? { controls: o.controls.map((q) => qubitMap[q] ?? q) } : {}),
  }));
  return { ...circuit, ops: [...circuit.ops, ...ops] };
}

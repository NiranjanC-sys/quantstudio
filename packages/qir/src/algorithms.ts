/**
 * Reference circuits.
 *
 * These are the circuits lessons embed, tests assert against, and the AI tutor
 * compares a learner's attempt to. They are written to be readable rather than
 * minimal, because they are teaching artefacts first.
 */

import { emptyCircuit, type Circuit, type Op } from './types.js';

let n = 0;
const id = () => `a${(n++).toString(36)}`;

function op(gate: string, targets: number[], extra: Partial<Op> = {}): Op {
  return { id: id(), gate, targets, ...extra };
}

export function bellState(which: 0 | 1 | 2 | 3 = 0): Circuit {
  const c = emptyCircuit(2, 2, `bell-phi${which}`);
  const ops: Op[] = [op('h', [0]), op('x', [1], { controls: [0] })];
  if (which === 1 || which === 3) ops.unshift(op('x', [1]));
  if (which === 2 || which === 3) ops.unshift(op('x', [0]));
  return { ...c, ops };
}

export function ghzState(qubits = 3): Circuit {
  const c = emptyCircuit(qubits, qubits, `ghz-${qubits}`);
  const ops: Op[] = [op('h', [0])];
  for (let i = 1; i < qubits; i++) ops.push(op('x', [i], { controls: [i - 1] }));
  return { ...c, ops };
}

export function wState(): Circuit {
  // |W> = (|100> + |010> + |001>)/sqrt(3).
  // Build it by splitting amplitude down the register: put all of it on q0,
  // then peel off the right fraction at each step and move it along.
  const theta1 = 2 * Math.acos(1 / Math.sqrt(3));
  const c = emptyCircuit(3, 3, 'w-state');
  return {
    ...c,
    ops: [
      op('x', [0]),
      op('ry', [1], { controls: [0], params: [theta1] }),
      op('x', [0], { controls: [1] }),
      op('ry', [2], { controls: [1], params: [Math.PI / 2] }),
      op('x', [1], { controls: [2] }),
    ],
  };
}

export function qft(qubits: number, withSwaps = true): Circuit {
  const c = emptyCircuit(qubits, qubits, `qft-${qubits}`);
  const ops: Op[] = [];
  for (let j = 0; j < qubits; j++) {
    ops.push(op('h', [j]));
    for (let k = j + 1; k < qubits; k++) {
      ops.push(op('p', [j], { controls: [k], params: [Math.PI / 2 ** (k - j)] }));
    }
  }
  if (withSwaps) {
    for (let i = 0; i < Math.floor(qubits / 2); i++) {
      ops.push(op('swap', [i, qubits - 1 - i]));
    }
  }
  return { ...c, ops };
}

/** Phase oracle marking one basis state, as used by Grover. */
export function phaseOracle(qubits: number, marked: number): Circuit {
  const c = emptyCircuit(qubits, qubits, `oracle-${marked}`);
  const ops: Op[] = [];
  const bits = marked.toString(2).padStart(qubits, '0');
  const flips = [...bits].map((b, i) => (b === '0' ? i : -1)).filter((i) => i >= 0);
  for (const q of flips) ops.push(op('x', [q]));
  if (qubits === 1) ops.push(op('z', [0]));
  else ops.push(op('z', [qubits - 1], { controls: Array.from({ length: qubits - 1 }, (_, i) => i) }));
  for (const q of flips) ops.push(op('x', [q]));
  return { ...c, ops };
}

export function groverDiffuser(qubits: number): Circuit {
  const c = emptyCircuit(qubits, qubits, 'diffuser');
  const ops: Op[] = [];
  for (let q = 0; q < qubits; q++) ops.push(op('h', [q]));
  for (let q = 0; q < qubits; q++) ops.push(op('x', [q]));
  if (qubits === 1) ops.push(op('z', [0]));
  else ops.push(op('z', [qubits - 1], { controls: Array.from({ length: qubits - 1 }, (_, i) => i) }));
  for (let q = 0; q < qubits; q++) ops.push(op('x', [q]));
  for (let q = 0; q < qubits; q++) ops.push(op('h', [q]));
  return { ...c, ops };
}

/** Optimal iteration count for one marked item in a space of 2^n. */
export function groverIterations(qubits: number, solutions = 1): number {
  // floor, not round. Rounding up over-rotates past the marked state: at
  // N=4 the exact optimum is 1 iteration (p=1), and 2 iterations drops to 0.25.
  const N = 2 ** qubits;
  return Math.max(1, Math.floor((Math.PI / 4) * Math.sqrt(N / solutions)));
}

export function grover(qubits: number, marked: number, iterations?: number): Circuit {
  const iters = iterations ?? groverIterations(qubits);
  const ops: Op[] = [];
  for (let q = 0; q < qubits; q++) ops.push(op('h', [q]));
  const oracle = phaseOracle(qubits, marked);
  const diff = groverDiffuser(qubits);
  for (let i = 0; i < iters; i++) {
    ops.push(...oracle.ops.map((o) => ({ ...o, id: id() })));
    ops.push({ id: id(), gate: 'barrier', targets: Array.from({ length: qubits }, (_, k) => k) });
    ops.push(...diff.ops.map((o) => ({ ...o, id: id() })));
  }
  return { ...emptyCircuit(qubits, qubits, `grover-${qubits}q-m${marked}`), ops };
}

export function deutschJozsa(qubits: number, kind: 'constant' | 'balanced'): Circuit {
  const total = qubits + 1;
  const ops: Op[] = [];
  ops.push(op('x', [qubits]));
  for (let q = 0; q <= qubits; q++) ops.push(op('h', [q]));
  if (kind === 'balanced') {
    for (let q = 0; q < qubits; q++) ops.push(op('x', [qubits], { controls: [q] }));
  }
  for (let q = 0; q < qubits; q++) ops.push(op('h', [q]));
  for (let q = 0; q < qubits; q++) ops.push(op('measure', [q], { cbits: [q] }));
  return { ...emptyCircuit(total, qubits, `deutsch-jozsa-${kind}`), ops };
}

export function bernsteinVazirani(secret: string): Circuit {
  const nq = secret.length;
  const total = nq + 1;
  const ops: Op[] = [op('x', [nq])];
  for (let q = 0; q <= nq; q++) ops.push(op('h', [q]));
  [...secret].forEach((b, i) => {
    if (b === '1') ops.push(op('x', [nq], { controls: [i] }));
  });
  for (let q = 0; q < nq; q++) ops.push(op('h', [q]));
  for (let q = 0; q < nq; q++) ops.push(op('measure', [q], { cbits: [q] }));
  return { ...emptyCircuit(total, nq, `bernstein-vazirani-${secret}`), ops };
}

/** Teleport the state of qubit 0 to qubit 2, using the Bell pair on 1 and 2. */
export function teleportation(prepare: Op[] = []): Circuit {
  const ops: Op[] = [
    ...prepare.map((o) => ({ ...o, id: id() })),
    op('barrier', [0, 1, 2]),
    op('h', [1]),
    op('x', [2], { controls: [1] }),
    op('barrier', [0, 1, 2]),
    op('x', [1], { controls: [0] }),
    op('h', [0]),
    op('measure', [0], { cbits: [0] }),
    op('measure', [1], { cbits: [1] }),
    op('barrier', [0, 1, 2]),
    op('x', [2], { condition: { bits: [1], value: 1 } }),
    op('z', [2], { condition: { bits: [0], value: 1 } }),
  ];
  return { ...emptyCircuit(3, 2, 'teleportation'), ops };
}

export function superdenseCoding(message: '00' | '01' | '10' | '11'): Circuit {
  const ops: Op[] = [op('h', [0]), op('x', [1], { controls: [0] }), op('barrier', [0, 1])];
  if (message === '01' || message === '11') ops.push(op('x', [0]));
  if (message === '10' || message === '11') ops.push(op('z', [0]));
  ops.push(
    op('barrier', [0, 1]),
    op('x', [1], { controls: [0] }),
    op('h', [0]),
    op('measure', [0], { cbits: [0] }),
    op('measure', [1], { cbits: [1] }),
  );
  return { ...emptyCircuit(2, 2, `superdense-${message}`), ops };
}

/** Quantum phase estimation of a Z-rotation by `phase` turns, on `counting` qubits. */
export function phaseEstimation(counting: number, phase: number): Circuit {
  const total = counting + 1;
  const target = counting;
  const ops: Op[] = [op('x', [target])];
  for (let q = 0; q < counting; q++) ops.push(op('h', [q]));
  for (let q = 0; q < counting; q++) {
    const reps = 2 ** (counting - 1 - q);
    ops.push(op('p', [target], { controls: [q], params: [2 * Math.PI * phase * reps] }));
  }
  const inv = qft(counting, true);
  const invOps = [...inv.ops].reverse().map((o) => ({
    ...o,
    id: id(),
    params: o.params?.map((p) => (typeof p === 'number' ? -p : p)),
  }));
  ops.push(...invOps);
  for (let q = 0; q < counting; q++) ops.push(op('measure', [q], { cbits: [q] }));
  return { ...emptyCircuit(total, counting, `qpe-${counting}`), ops };
}

/** One QAOA layer for Max-Cut on the given edge list. */
export function qaoaMaxCut(qubits: number, edges: [number, number][], gamma: number, beta: number, layers = 1): Circuit {
  const ops: Op[] = [];
  for (let q = 0; q < qubits; q++) ops.push(op('h', [q]));
  for (let l = 0; l < layers; l++) {
    for (const [a, b] of edges) ops.push(op('rzz', [a, b], { params: [2 * gamma] }));
    ops.push(op('barrier', Array.from({ length: qubits }, (_, i) => i)));
    for (let q = 0; q < qubits; q++) ops.push(op('rx', [q], { params: [2 * beta] }));
  }
  for (let q = 0; q < qubits; q++) ops.push(op('measure', [q], { cbits: [q] }));
  return { ...emptyCircuit(qubits, qubits, `qaoa-maxcut-p${layers}`), ops };
}

/** CHSH test circuit at the given measurement angles. */
export function chsh(alice: number, bob: number): Circuit {
  const ops: Op[] = [
    op('h', [0]),
    op('x', [1], { controls: [0] }),
    op('barrier', [0, 1]),
    op('ry', [0], { params: [-2 * alice] }),
    op('ry', [1], { params: [-2 * bob] }),
    op('measure', [0], { cbits: [0] }),
    op('measure', [1], { cbits: [1] }),
  ];
  return { ...emptyCircuit(2, 2, 'chsh'), ops };
}

/** Three-qubit bit-flip repetition code: encode, inject, syndrome, correct. */
export function bitFlipCode(injectOn: number | null = 1): Circuit {
  const ops: Op[] = [
    op('x', [1], { controls: [0] }),
    op('x', [2], { controls: [0] }),
    op('barrier', [0, 1, 2, 3, 4]),
  ];
  if (injectOn !== null) ops.push(op('x', [injectOn]));
  ops.push(
    op('barrier', [0, 1, 2, 3, 4]),
    op('x', [3], { controls: [0] }),
    op('x', [3], { controls: [1] }),
    op('x', [4], { controls: [1] }),
    op('x', [4], { controls: [2] }),
    op('measure', [3], { cbits: [0] }),
    op('measure', [4], { cbits: [1] }),
  );
  return { ...emptyCircuit(5, 2, 'bit-flip-code'), ops };
}

export const CATALOG = {
  bellState,
  ghzState,
  qft,
  grover,
  groverIterations,
  phaseOracle,
  groverDiffuser,
  deutschJozsa,
  bernsteinVazirani,
  teleportation,
  superdenseCoding,
  phaseEstimation,
  qaoaMaxCut,
  chsh,
  bitFlipCode,
};

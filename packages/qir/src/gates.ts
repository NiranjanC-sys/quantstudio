/**
 * The gate registry.
 *
 * CONVENTION, stated once and never violated: qubit 0 is the MOST significant
 * bit of a basis index. For n qubits, basis state index `i` assigns qubit `q`
 * the value `(i >> (n - 1 - q)) & 1`. So a 2-qubit state |q0 q1> reads left to
 * right, matching Nielsen & Chuang, Cirq, and every lecture course we
 * benchmarked. Qiskit uses the opposite order; `codegen/qiskit.ts` and
 * `parse/qasm3.ts` convert at the boundary, and lesson T0.M5.L3 teaches exactly
 * this discrepancy.
 *
 * Multi-qubit matrices below are therefore written with the FIRST operand as
 * the most significant bit.
 */

import { cmat, type CMatrix } from './complex.js';

export type GateCategory =
  | 'pauli'
  | 'hadamard'
  | 'phase'
  | 'rotation'
  | 'universal'
  | 'two-qubit'
  | 'multi'
  | 'nonunitary';

export interface GateDef {
  key: string;
  name: string;
  /** Short glyph for the circuit tile. */
  glyph: string;
  /** Number of qubits the definition itself acts on (controls in Op are extra). */
  arity: number;
  paramNames: string[];
  category: GateCategory;
  /** Preserves the Pauli group under conjugation. */
  clifford: boolean;
  /** Undefined for measure, reset and barrier. */
  matrix?: (p: readonly number[]) => CMatrix;
  /** Canonical rewrite into a base gate plus implicit controls. */
  controlledForm?: { base: string; controls: number };
  /** Inverse as (gate key, param transform). */
  inverse?: { gate: string; params?: (p: readonly number[]) => number[] };
  /** Native OpenQASM 3 / stdgates.inc name, when it differs from `key`. */
  qasmName?: string;
  description: string;
}

const S2 = Math.SQRT1_2;
const I2 = () => cmat(2, [1, 0, 0, 0, 0, 0, 1, 0]);

function rot(theta: number, kind: 'x' | 'y' | 'z'): CMatrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  if (kind === 'x') return cmat(2, [c, 0, 0, -s, 0, -s, c, 0]);
  if (kind === 'y') return cmat(2, [c, 0, -s, 0, s, 0, c, 0]);
  return cmat(2, [Math.cos(-theta / 2), Math.sin(-theta / 2), 0, 0, 0, 0, Math.cos(theta / 2), Math.sin(theta / 2)]);
}

function uMat(theta: number, phi: number, lam: number): CMatrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return cmat(2, [
    c, 0,
    -Math.cos(lam) * s, -Math.sin(lam) * s,
    Math.cos(phi) * s, Math.sin(phi) * s,
    Math.cos(phi + lam) * c, Math.sin(phi + lam) * c,
  ]);
}

/** exp(-i theta/2 * A tensor B) for the two-qubit Pauli products we support. */
function pauliRot2(theta: number, pp: 'xx' | 'yy' | 'zz' | 'zx'): CMatrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  const m = cmat(4);
  const put = (r: number, col: number, re: number, im: number) => {
    const k = 2 * (r * 4 + col);
    m.d[k] = re;
    m.d[k + 1] = im;
  };
  for (let i = 0; i < 4; i++) put(i, i, c, 0);
  if (pp === 'xx') {
    put(0, 3, 0, -s); put(1, 2, 0, -s); put(2, 1, 0, -s); put(3, 0, 0, -s);
  } else if (pp === 'yy') {
    put(0, 3, 0, s); put(1, 2, 0, -s); put(2, 1, 0, -s); put(3, 0, 0, s);
  } else if (pp === 'zz') {
    put(0, 0, c, -s); put(1, 1, c, s); put(2, 2, c, s); put(3, 3, c, -s);
  } else {
    put(0, 1, 0, -s); put(1, 0, 0, -s); put(2, 3, 0, s); put(3, 2, 0, s);
  }
  return m;
}

function perm(n: number, mapping: readonly number[]): CMatrix {
  const m = cmat(n);
  for (let col = 0; col < n; col++) {
    const row = mapping[col]!;
    m.d[2 * (row * n + col)] = 1;
  }
  return m;
}

export const GATES: Record<string, GateDef> = {
  // ---- single qubit, non-parametric -------------------------------------
  id: { key: 'id', name: 'Identity', glyph: 'I', arity: 1, paramNames: [], category: 'pauli', clifford: true, matrix: I2, inverse: { gate: 'id' }, description: 'Does nothing. Useful as an explicit delay.' },
  x: { key: 'x', name: 'Pauli X', glyph: 'X', arity: 1, paramNames: [], category: 'pauli', clifford: true, matrix: () => cmat(2, [0, 0, 1, 0, 1, 0, 0, 0]), inverse: { gate: 'x' }, description: 'Bit flip. A pi rotation about the x axis of the Bloch sphere.' },
  y: { key: 'y', name: 'Pauli Y', glyph: 'Y', arity: 1, paramNames: [], category: 'pauli', clifford: true, matrix: () => cmat(2, [0, 0, 0, -1, 0, 1, 0, 0]), inverse: { gate: 'y' }, description: 'Bit and phase flip together. A pi rotation about y.' },
  z: { key: 'z', name: 'Pauli Z', glyph: 'Z', arity: 1, paramNames: [], category: 'pauli', clifford: true, matrix: () => cmat(2, [1, 0, 0, 0, 0, 0, -1, 0]), inverse: { gate: 'z' }, description: 'Phase flip. Leaves |0> alone and negates |1>.' },
  h: { key: 'h', name: 'Hadamard', glyph: 'H', arity: 1, paramNames: [], category: 'hadamard', clifford: true, matrix: () => cmat(2, [S2, 0, S2, 0, S2, 0, -S2, 0]), inverse: { gate: 'h' }, description: 'Maps the computational basis to the x basis. The source of superposition.' },
  s: { key: 's', name: 'S', glyph: 'S', arity: 1, paramNames: [], category: 'phase', clifford: true, matrix: () => cmat(2, [1, 0, 0, 0, 0, 0, 0, 1]), inverse: { gate: 'sdg' }, description: 'Quarter turn about z. Square root of Z.' },
  sdg: { key: 'sdg', name: 'S dagger', glyph: 'S†', arity: 1, paramNames: [], category: 'phase', clifford: true, matrix: () => cmat(2, [1, 0, 0, 0, 0, 0, 0, -1]), inverse: { gate: 's' }, description: 'Inverse of S.' },
  t: { key: 't', name: 'T', glyph: 'T', arity: 1, paramNames: [], category: 'phase', clifford: false, matrix: () => cmat(2, [1, 0, 0, 0, 0, 0, S2, S2]), inverse: { gate: 'tdg' }, description: 'Eighth turn about z. The non-Clifford gate that makes universality possible, and the expensive one under error correction.' },
  tdg: { key: 'tdg', name: 'T dagger', glyph: 'T†', arity: 1, paramNames: [], category: 'phase', clifford: false, matrix: () => cmat(2, [1, 0, 0, 0, 0, 0, S2, -S2]), inverse: { gate: 't' }, description: 'Inverse of T.' },
  sx: { key: 'sx', name: 'Square root of X', glyph: '√X', arity: 1, paramNames: [], category: 'rotation', clifford: true, matrix: () => cmat(2, [0.5, 0.5, 0.5, -0.5, 0.5, -0.5, 0.5, 0.5]), inverse: { gate: 'sxdg' }, description: 'Half turn about x. A native basis gate on IBM superconducting hardware.' },
  sxdg: { key: 'sxdg', name: 'Inverse root X', glyph: '√X†', arity: 1, paramNames: [], category: 'rotation', clifford: true, matrix: () => cmat(2, [0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5]), inverse: { gate: 'sx' }, description: 'Inverse of the square root of X.' },

  // ---- single qubit, parametric -----------------------------------------
  rx: { key: 'rx', name: 'Rx', glyph: 'Rx', arity: 1, paramNames: ['theta'], category: 'rotation', clifford: false, matrix: (p) => rot(p[0]!, 'x'), inverse: { gate: 'rx', params: (p) => [-p[0]!] }, description: 'Rotation by theta about the x axis.' },
  ry: { key: 'ry', name: 'Ry', glyph: 'Ry', arity: 1, paramNames: ['theta'], category: 'rotation', clifford: false, matrix: (p) => rot(p[0]!, 'y'), inverse: { gate: 'ry', params: (p) => [-p[0]!] }, description: 'Rotation by theta about the y axis.' },
  rz: { key: 'rz', name: 'Rz', glyph: 'Rz', arity: 1, paramNames: ['theta'], category: 'rotation', clifford: false, matrix: (p) => rot(p[0]!, 'z'), inverse: { gate: 'rz', params: (p) => [-p[0]!] }, description: 'Rotation by theta about z. On real hardware this is often free, done in software by shifting a phase.' },
  p: { key: 'p', name: 'Phase', glyph: 'P', arity: 1, paramNames: ['lambda'], category: 'phase', clifford: false, matrix: (p) => cmat(2, [1, 0, 0, 0, 0, 0, Math.cos(p[0]!), Math.sin(p[0]!)]), inverse: { gate: 'p', params: (p) => [-p[0]!] }, description: 'Adds a relative phase to |1>. Rz up to a global phase.' },
  u: { key: 'u', name: 'General unitary', glyph: 'U', arity: 1, paramNames: ['theta', 'phi', 'lambda'], category: 'universal', clifford: false, matrix: (p) => uMat(p[0]!, p[1]!, p[2]!), inverse: { gate: 'u', params: (p) => [-p[0]!, -p[2]!, -p[1]!] }, description: 'Any single-qubit unitary, up to a global phase.' },

  // ---- two qubit, non-controlled ----------------------------------------
  swap: { key: 'swap', name: 'Swap', glyph: 'SWAP', arity: 2, paramNames: [], category: 'two-qubit', clifford: true, matrix: () => perm(4, [0, 2, 1, 3]), inverse: { gate: 'swap' }, description: 'Exchanges two qubits. Costs three CNOTs, which is why routing is expensive.' },
  iswap: { key: 'iswap', name: 'iSwap', glyph: 'iSWAP', arity: 2, paramNames: [], category: 'two-qubit', clifford: false, matrix: () => cmat(4, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]), description: 'Swap with an i phase on the exchanged amplitudes. Native on some superconducting devices.' },
  rxx: { key: 'rxx', name: 'Rxx', glyph: 'Rxx', arity: 2, paramNames: ['theta'], category: 'two-qubit', clifford: false, matrix: (p) => pauliRot2(p[0]!, 'xx'), inverse: { gate: 'rxx', params: (p) => [-p[0]!] }, description: 'exp(-i theta/2 X⊗X). The native two-qubit interaction on trapped-ion hardware.' },
  ryy: { key: 'ryy', name: 'Ryy', glyph: 'Ryy', arity: 2, paramNames: ['theta'], category: 'two-qubit', clifford: false, matrix: (p) => pauliRot2(p[0]!, 'yy'), inverse: { gate: 'ryy', params: (p) => [-p[0]!] }, description: 'exp(-i theta/2 Y⊗Y).' },
  rzz: { key: 'rzz', name: 'Rzz', glyph: 'Rzz', arity: 2, paramNames: ['theta'], category: 'two-qubit', clifford: false, matrix: (p) => pauliRot2(p[0]!, 'zz'), inverse: { gate: 'rzz', params: (p) => [-p[0]!] }, description: 'exp(-i theta/2 Z⊗Z). The workhorse of QAOA cost layers.' },
  rzx: { key: 'rzx', name: 'Rzx', glyph: 'Rzx', arity: 2, paramNames: ['theta'], category: 'two-qubit', clifford: false, matrix: (p) => pauliRot2(p[0]!, 'zx'), inverse: { gate: 'rzx', params: (p) => [-p[0]!] }, description: 'exp(-i theta/2 Z⊗X). The cross-resonance interaction underneath IBM two-qubit gates.' },
  ecr: { key: 'ecr', name: 'Echoed cross-resonance', glyph: 'ECR', arity: 2, paramNames: [], category: 'two-qubit', clifford: true, matrix: () => cmat(4, [
    0, 0, 0, 0, S2, 0, 0, S2,
    0, 0, 0, 0, 0, S2, S2, 0,
    S2, 0, 0, -S2, 0, 0, 0, 0,
    0, -S2, S2, 0, 0, 0, 0, 0,
  ]), inverse: { gate: 'ecr' }, description: 'An IBM hardware basis gate. Locally equivalent to CNOT.' },

  // ---- controlled aliases ----------------------------------------------
  cx: { key: 'cx', name: 'CNOT', glyph: 'X', arity: 2, paramNames: [], category: 'two-qubit', clifford: true, matrix: () => perm(4, [0, 1, 3, 2]), controlledForm: { base: 'x', controls: 1 }, inverse: { gate: 'cx' }, description: 'Flips the target when the control is |1>. Together with single-qubit gates it is universal.' },
  cy: { key: 'cy', name: 'Controlled Y', glyph: 'Y', arity: 2, paramNames: [], category: 'two-qubit', clifford: true, controlledForm: { base: 'y', controls: 1 }, inverse: { gate: 'cy' }, description: 'Y on the target, conditioned on the control.' },
  cz: { key: 'cz', name: 'Controlled Z', glyph: 'Z', arity: 2, paramNames: [], category: 'two-qubit', clifford: true, matrix: () => cmat(4, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 0]), controlledForm: { base: 'z', controls: 1 }, inverse: { gate: 'cz' }, description: 'Negates the |11> amplitude. Symmetric in its two qubits.' },
  ch: { key: 'ch', name: 'Controlled H', glyph: 'H', arity: 2, paramNames: [], category: 'two-qubit', clifford: false, controlledForm: { base: 'h', controls: 1 }, inverse: { gate: 'ch' }, description: 'Hadamard on the target, conditioned on the control.' },
  cs: { key: 'cs', name: 'Controlled S', glyph: 'S', arity: 2, paramNames: [], category: 'two-qubit', clifford: false, controlledForm: { base: 's', controls: 1 }, inverse: { gate: 'csdg' }, description: 'S on the target, conditioned on the control.' },
  csdg: { key: 'csdg', name: 'Controlled S dagger', glyph: 'S†', arity: 2, paramNames: [], category: 'two-qubit', clifford: false, controlledForm: { base: 'sdg', controls: 1 }, inverse: { gate: 'cs' }, description: 'Inverse controlled S.' },
  csx: { key: 'csx', name: 'Controlled root X', glyph: '√X', arity: 2, paramNames: [], category: 'two-qubit', clifford: false, controlledForm: { base: 'sx', controls: 1 }, description: 'Square root of X on the target, conditioned on the control.' },
  cp: { key: 'cp', name: 'Controlled phase', glyph: 'P', arity: 2, paramNames: ['lambda'], category: 'two-qubit', clifford: false, controlledForm: { base: 'p', controls: 1 }, inverse: { gate: 'cp', params: (p) => [-p[0]!] }, description: 'The building block of the quantum Fourier transform.' },
  crx: { key: 'crx', name: 'Controlled Rx', glyph: 'Rx', arity: 2, paramNames: ['theta'], category: 'two-qubit', clifford: false, controlledForm: { base: 'rx', controls: 1 }, inverse: { gate: 'crx', params: (p) => [-p[0]!] }, description: 'Rx on the target, conditioned on the control.' },
  cry: { key: 'cry', name: 'Controlled Ry', glyph: 'Ry', arity: 2, paramNames: ['theta'], category: 'two-qubit', clifford: false, controlledForm: { base: 'ry', controls: 1 }, inverse: { gate: 'cry', params: (p) => [-p[0]!] }, description: 'Ry on the target, conditioned on the control. Common in amplitude encoding.' },
  crz: { key: 'crz', name: 'Controlled Rz', glyph: 'Rz', arity: 2, paramNames: ['theta'], category: 'two-qubit', clifford: false, controlledForm: { base: 'rz', controls: 1 }, inverse: { gate: 'crz', params: (p) => [-p[0]!] }, description: 'Rz on the target, conditioned on the control.' },
  cu: { key: 'cu', name: 'Controlled U', glyph: 'U', arity: 2, paramNames: ['theta', 'phi', 'lambda'], category: 'two-qubit', clifford: false, controlledForm: { base: 'u', controls: 1 }, description: 'An arbitrary single-qubit unitary, conditioned on the control.' },
  ccx: { key: 'ccx', name: 'Toffoli', glyph: 'X', arity: 3, paramNames: [], category: 'multi', clifford: false, matrix: () => perm(8, [0, 1, 2, 3, 4, 5, 7, 6]), controlledForm: { base: 'x', controls: 2 }, inverse: { gate: 'ccx' }, description: 'Universal for classical reversible computation. Costs six CNOTs to decompose.' },
  ccz: { key: 'ccz', name: 'CCZ', glyph: 'Z', arity: 3, paramNames: [], category: 'multi', clifford: false, controlledForm: { base: 'z', controls: 2 }, inverse: { gate: 'ccz' }, description: 'Negates only the |111> amplitude.' },
  cswap: { key: 'cswap', name: 'Fredkin', glyph: 'SWAP', arity: 3, paramNames: [], category: 'multi', clifford: false, matrix: () => perm(8, [0, 1, 2, 3, 4, 6, 5, 7]), controlledForm: { base: 'swap', controls: 1 }, inverse: { gate: 'cswap' }, description: 'Swaps two qubits when the control is set. Used in the swap test.' },
  mcx: { key: 'mcx', name: 'Multi-controlled X', glyph: 'X', arity: 1, paramNames: [], category: 'multi', clifford: false, controlledForm: { base: 'x', controls: -1 }, description: 'X with any number of controls. The controls live in the op, not the definition.' },

  // ---- non-unitary ------------------------------------------------------
  measure: { key: 'measure', name: 'Measure', glyph: 'M', arity: 1, paramNames: [], category: 'nonunitary', clifford: false, description: 'Projective measurement in the computational basis, recording the outcome in a classical bit.' },
  reset: { key: 'reset', name: 'Reset', glyph: '|0>', arity: 1, paramNames: [], category: 'nonunitary', clifford: false, description: 'Forces the qubit to |0>. Physically a measurement plus a conditional flip.' },
  barrier: { key: 'barrier', name: 'Barrier', glyph: '‖', arity: 1, paramNames: [], category: 'nonunitary', clifford: true, description: 'A compiler fence. No physical effect; stops optimisation across it.' },
};

export const GATE_KEYS = Object.keys(GATES);

export function gate(key: string): GateDef {
  const g = GATES[key];
  if (!g) throw new Error(`unknown gate '${key}'`);
  return g;
}

export function isUnitaryGate(key: string): boolean {
  return GATES[key]?.category !== 'nonunitary';
}

/** Gates grouped for the builder's palette, in teaching order. */
export const PALETTE: { group: string; keys: string[] }[] = [
  { group: 'Pauli', keys: ['x', 'y', 'z', 'id'] },
  { group: 'Superposition', keys: ['h', 'sx', 'sxdg'] },
  { group: 'Phase', keys: ['s', 'sdg', 't', 'tdg', 'p'] },
  { group: 'Rotation', keys: ['rx', 'ry', 'rz', 'u'] },
  { group: 'Controlled', keys: ['cx', 'cy', 'cz', 'ch', 'cp', 'crx', 'cry', 'crz', 'cu', 'cs', 'csdg', 'csx'] },
  { group: 'Two qubit', keys: ['swap', 'iswap', 'rxx', 'ryy', 'rzz', 'rzx', 'ecr'] },
  { group: 'Three qubit', keys: ['ccx', 'ccz', 'cswap', 'mcx'] },
  { group: 'Non unitary', keys: ['measure', 'reset', 'barrier'] },
];

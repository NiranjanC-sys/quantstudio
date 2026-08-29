/**
 * Browser statevector simulator.
 *
 * This is tier T-A of the simulation design: it runs in the learner's tab so
 * that editing a circuit re-simulates at frame rate with no network round trip.
 * Comfortable to 14 qubits (16,384 amplitudes); the admission check refuses
 * beyond `maxQubits` rather than locking up the tab.
 *
 * Qubit 0 is the most significant bit. See gates.ts for the full convention.
 */

import { gate, GATES } from './gates.js';
import { type CMatrix } from './complex.js';
import { mulberry32 } from './rng.js';
import {
  type Circuit,
  type Op,
  IRError,
  opQubits,
  resolveParams,
} from './types.js';

export interface NoiseModel {
  /** Depolarising probability applied after every 1-qubit gate. */
  depolarising1?: number;
  /** Depolarising probability applied after every 2-qubit gate. */
  depolarising2?: number;
  /** Amplitude damping (T1) probability per gate layer. */
  amplitudeDamping?: number;
  /** Phase damping (T2) probability per gate layer. */
  phaseDamping?: number;
  /** Probability a measurement reports the wrong bit. */
  readout?: number;
}

export interface SimOptions {
  shots?: number;
  seed?: number;
  bindings?: Record<string, number>;
  noise?: NoiseModel;
  maxQubits?: number;
  /** Cap on trajectories when the circuit is stochastic. */
  maxTrajectories?: number;
}

export interface BlochVector {
  x: number;
  y: number;
  z: number;
  /** Length of the vector: 1 for a pure state, less when entangled or noisy. */
  purity: number;
}

export interface SimResult {
  qubits: number;
  clbits: number;
  /** Exact amplitudes, interleaved re/im. Absent when the run was stochastic. */
  statevector: Float64Array | null;
  /** Marginal probability of each computational basis state. */
  probabilities: Float64Array;
  /** Sampled bitstring counts, present when shots > 0. */
  counts: Record<string, number> | null;
  bloch: BlochVector[];
  /** True when the result came from sampling rather than exact evolution. */
  stochastic: boolean;
  trajectories: number;
}

export const DEFAULT_MAX_QUBITS = 20;

function zeroState(n: number): Float64Array {
  const s = new Float64Array(2 << n);
  s[0] = 1;
  return s;
}

/**
 * Apply a dense matrix over `targets`, gated on `controls` all being |1>.
 *
 * Enumerates only the base indices (target bits zero, controls satisfied) and
 * gathers a 2^k block for each, so the cost is O(2^n * 2^k) with no allocation
 * inside the hot loop.
 */
export function applyMatrix(
  state: Float64Array,
  n: number,
  targets: readonly number[],
  controls: readonly number[],
  m: CMatrix,
): void {
  const k = targets.length;
  const dim = 1 << k;
  if (m.n !== dim) throw new IRError(`matrix of size ${m.n} cannot act on ${k} qubits`);

  let tmask = 0;
  const offs = new Int32Array(dim);
  const tpos: number[] = [];
  for (let i = 0; i < k; i++) {
    const bit = n - 1 - targets[i]!;
    tpos.push(bit);
    tmask |= 1 << bit;
  }
  for (let j = 0; j < dim; j++) {
    let o = 0;
    for (let i = 0; i < k; i++) {
      if ((j >> (k - 1 - i)) & 1) o |= 1 << tpos[i]!;
    }
    offs[j] = o;
  }

  let cmask = 0;
  for (const c of controls) cmask |= 1 << (n - 1 - c);

  const N = 1 << n;
  const re = new Float64Array(dim);
  const im = new Float64Array(dim);

  for (let base = 0; base < N; base++) {
    if ((base & tmask) !== 0) continue;
    if ((base & cmask) !== cmask) continue;
    for (let j = 0; j < dim; j++) {
      const idx = 2 * (base | offs[j]!);
      re[j] = state[idx]!;
      im[j] = state[idx + 1]!;
    }
    for (let r = 0; r < dim; r++) {
      let ar = 0;
      let ai = 0;
      const rowOff = 2 * r * dim;
      for (let c = 0; c < dim; c++) {
        const mr = m.d[rowOff + 2 * c]!;
        const mi = m.d[rowOff + 2 * c + 1]!;
        if (mr === 0 && mi === 0) continue;
        const vr = re[c]!;
        const vi = im[c]!;
        ar += mr * vr - mi * vi;
        ai += mr * vi + mi * vr;
      }
      const idx = 2 * (base | offs[r]!);
      state[idx] = ar;
      state[idx + 1] = ai;
    }
  }
}

/** Probability that measuring `q` in the computational basis yields 1. */
export function probabilityOfOne(state: Float64Array, n: number, q: number): number {
  const bit = 1 << (n - 1 - q);
  const N = 1 << n;
  let p = 0;
  for (let i = 0; i < N; i++) {
    if (i & bit) {
      const k = 2 * i;
      p += state[k]! * state[k]! + state[k + 1]! * state[k + 1]!;
    }
  }
  return p;
}

/** Collapse `q` onto `outcome` and renormalise in place. */
export function collapse(state: Float64Array, n: number, q: number, outcome: 0 | 1): void {
  const bit = 1 << (n - 1 - q);
  const N = 1 << n;
  let norm = 0;
  for (let i = 0; i < N; i++) {
    const has = (i & bit) !== 0 ? 1 : 0;
    const k = 2 * i;
    if (has !== outcome) {
      state[k] = 0;
      state[k + 1] = 0;
    } else {
      norm += state[k]! * state[k]! + state[k + 1]! * state[k + 1]!;
    }
  }
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  for (let i = 0; i < 2 * N; i++) state[i] = state[i]! * inv;
}

function randomPauli(rand: () => number): 'x' | 'y' | 'z' {
  const r = rand() * 3;
  return r < 1 ? 'x' : r < 2 ? 'y' : 'z';
}

function applyKrausTrajectory(
  state: Float64Array,
  n: number,
  q: number,
  kind: 'amp' | 'phase',
  p: number,
  rand: () => number,
): void {
  // Quantum-trajectory unravelling: sample which Kraus branch fired, then
  // project and renormalise. Cheaper than carrying a density matrix and exact
  // in the limit of many shots.
  const p1 = probabilityOfOne(state, n, q);
  if (kind === 'amp') {
    if (rand() < p * p1) {
      collapse(state, n, q, 1);
      applyMatrix(state, n, [q], [], gate('x').matrix!([]));
    }
  } else if (rand() < p) {
    applyMatrix(state, n, [q], [], gate('z').matrix!([]));
  }
}

function isTerminalMeasurementOnly(ops: readonly Op[]): boolean {
  let seenNonUnitary = false;
  for (const op of ops) {
    const cat = GATES[op.gate]?.category;
    if (op.condition) return false;
    if (op.gate === 'reset') return false;
    if (cat === 'nonunitary' && op.gate === 'measure') {
      seenNonUnitary = true;
    } else if (op.gate === 'barrier') {
      continue;
    } else if (seenNonUnitary) {
      return false;
    }
  }
  return true;
}

interface RunOutcome {
  state: Float64Array;
  clbits: Uint8Array;
}

function runOnce(
  circuit: Circuit,
  opts: Required<Pick<SimOptions, 'bindings'>> & { noise?: NoiseModel; rand: () => number; ignoreMeasure?: boolean },
): RunOutcome {
  const n = circuit.qubits;
  const state = zeroState(n);
  const clbits = new Uint8Array(circuit.clbits);
  const { rand, noise } = opts;

  for (const op of circuit.ops) {
    if (op.condition) {
      let v = 0;
      op.condition.bits.forEach((b, i) => {
        v |= (clbits[b] ?? 0) << i;
      });
      if (v !== op.condition.value) continue;
    }

    if (op.gate === 'barrier') continue;

    if (op.gate === 'measure') {
      // On the exact path we report the pre-measurement statevector and sample
      // counts from it, so the measurement must not collapse anything here.
      if (opts.ignoreMeasure) continue;
      const q = op.targets[0]!;
      const p1 = probabilityOfOne(state, n, q);
      let outcome: 0 | 1 = rand() < p1 ? 1 : 0;
      collapse(state, n, q, outcome);
      if (noise?.readout && rand() < noise.readout) outcome = outcome === 1 ? 0 : 1;
      const cb = op.cbits?.[0];
      if (cb !== undefined && cb < clbits.length) clbits[cb] = outcome;
      continue;
    }

    if (op.gate === 'reset') {
      const q = op.targets[0]!;
      const p1 = probabilityOfOne(state, n, q);
      const outcome: 0 | 1 = rand() < p1 ? 1 : 0;
      collapse(state, n, q, outcome);
      if (outcome === 1) applyMatrix(state, n, [q], [], gate('x').matrix!([]));
      continue;
    }

    const def = gate(op.gate);
    const params = resolveParams(op.params, opts.bindings);
    let targets = op.targets;
    let controls = op.controls ?? [];

    // Rewrite a controlled alias into base gate plus controls so there is one
    // code path for cx, ccx and mcx alike.
    if (def.controlledForm && def.controlledForm.controls >= 0 && def.matrix === undefined) {
      const nc = def.controlledForm.controls;
      controls = [...controls, ...op.targets.slice(0, nc)];
      targets = op.targets.slice(nc);
    }
    const effective = def.controlledForm && def.matrix === undefined ? gate(def.controlledForm.base) : def;
    if (!effective.matrix) throw new IRError(`gate '${op.gate}' has no matrix`, op.id);

    applyMatrix(state, n, targets, controls, effective.matrix(params));

    if (noise) {
      const touched = opQubits(op);
      const p = touched.length >= 2 ? noise.depolarising2 : noise.depolarising1;
      if (p && p > 0) {
        for (const q of touched) {
          if (rand() < p) applyMatrix(state, n, [q], [], gate(randomPauli(rand)).matrix!([]));
        }
      }
      if (noise.amplitudeDamping) {
        for (const q of touched) applyKrausTrajectory(state, n, q, 'amp', noise.amplitudeDamping, rand);
      }
      if (noise.phaseDamping) {
        for (const q of touched) applyKrausTrajectory(state, n, q, 'phase', noise.phaseDamping, rand);
      }
    }
  }

  return { state, clbits };
}

export function probabilities(state: Float64Array, n: number): Float64Array {
  const N = 1 << n;
  const p = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const k = 2 * i;
    p[i] = state[k]! * state[k]! + state[k + 1]! * state[k + 1]!;
  }
  return p;
}

export function blochVectors(state: Float64Array, n: number): BlochVector[] {
  const out: BlochVector[] = [];
  const N = 1 << n;
  for (let q = 0; q < n; q++) {
    const bit = 1 << (n - 1 - q);
    let r00 = 0;
    let r11 = 0;
    let r01r = 0;
    let r01i = 0;
    for (let i = 0; i < N; i++) {
      if (i & bit) continue;
      const j = i | bit;
      const a = 2 * i;
      const b = 2 * j;
      const ar = state[a]!;
      const ai = state[a + 1]!;
      const br = state[b]!;
      const bi = state[b + 1]!;
      r00 += ar * ar + ai * ai;
      r11 += br * br + bi * bi;
      // rho01 = psi_0 * conj(psi_1)
      r01r += ar * br + ai * bi;
      r01i += ai * br - ar * bi;
    }
    const x = 2 * r01r;
    const y = -2 * r01i;
    const z = r00 - r11;
    out.push({ x, y, z, purity: Math.sqrt(x * x + y * y + z * z) });
  }
  return out;
}

function bitstring(clbits: Uint8Array): string {
  // Classical bit 0 printed LEFTMOST, matching our big-endian qubit order.
  // Qiskit prints the reverse; the emitters and lesson T0.M5.L3 cover that.
  let s = '';
  for (let i = 0; i < clbits.length; i++) s += clbits[i] ? '1' : '0';
  return s || '0';
}

function sampleFromProbabilities(
  p: Float64Array,
  n: number,
  shots: number,
  rand: () => number,
): Record<string, number> {
  const cum = new Float64Array(p.length);
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i]!;
    cum[i] = acc;
  }
  const counts: Record<string, number> = {};
  for (let s = 0; s < shots; s++) {
    const r = rand() * acc;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    const key = lo.toString(2).padStart(n, '0');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function simulate(circuit: Circuit, options: SimOptions = {}): SimResult {
  const n = circuit.qubits;
  const maxQubits = options.maxQubits ?? DEFAULT_MAX_QUBITS;
  if (n > maxQubits) {
    throw new IRError(
      `circuit needs ${n} qubits but this engine is capped at ${maxQubits}. ` +
        `Run it on the server backend instead.`,
    );
  }
  if (n < 1) throw new IRError('circuit must have at least one qubit');

  const shots = options.shots ?? 0;
  const bindings = options.bindings ?? {};
  const noise = options.noise;
  const rand = mulberry32(options.seed ?? 0x5eed);

  const hasNoise = !!noise && Object.values(noise).some((v) => typeof v === 'number' && v > 0);
  const stochastic = hasNoise || !isTerminalMeasurementOnly(circuit.ops);

  if (!stochastic) {
    const { state, clbits } = runOnce(circuit, { bindings, rand, ignoreMeasure: true });
    const probs = probabilities(state, n);
    let counts: Record<string, number> | null = null;
    if (shots > 0) {
      const measured = circuit.ops.filter((o) => o.gate === 'measure');
      if (measured.length === 0) {
        counts = sampleFromProbabilities(probs, n, shots, rand);
      } else {
        // Sample basis states, then project onto the measured classical bits.
        const raw = sampleFromProbabilities(probs, n, shots, rand);
        counts = {};
        for (const [basis, c] of Object.entries(raw)) {
          const cl = new Uint8Array(circuit.clbits);
          for (const op of measured) {
            const q = op.targets[0]!;
            const cb = op.cbits?.[0];
            if (cb !== undefined && cb < cl.length) cl[cb] = basis[q] === '1' ? 1 : 0;
          }
          const key = bitstring(cl);
          counts[key] = (counts[key] ?? 0) + c;
        }
      }
    }
    void clbits;
    return {
      qubits: n,
      clbits: circuit.clbits,
      statevector: state,
      probabilities: probs,
      counts,
      bloch: blochVectors(state, n),
      stochastic: false,
      trajectories: 1,
    };
  }

  const trajectories = Math.min(Math.max(shots, 1), options.maxTrajectories ?? 8192);
  const probs = new Float64Array(1 << n);
  const counts: Record<string, number> = {};
  const blochAcc: BlochVector[] = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, purity: 0 }));

  for (let t = 0; t < trajectories; t++) {
    const { state, clbits } = runOnce(circuit, { bindings, noise, rand });
    const p = probabilities(state, n);
    for (let i = 0; i < p.length; i++) probs[i] = probs[i]! + p[i]!;
    const bv = blochVectors(state, n);
    for (let q = 0; q < n; q++) {
      blochAcc[q]!.x += bv[q]!.x;
      blochAcc[q]!.y += bv[q]!.y;
      blochAcc[q]!.z += bv[q]!.z;
    }
    const key = circuit.ops.some((o) => o.gate === 'measure')
      ? bitstring(clbits)
      : sampleKeyFrom(p, n, rand);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  for (let i = 0; i < probs.length; i++) probs[i] = probs[i]! / trajectories;
  for (const b of blochAcc) {
    b.x /= trajectories;
    b.y /= trajectories;
    b.z /= trajectories;
    b.purity = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
  }

  return {
    qubits: n,
    clbits: circuit.clbits,
    statevector: null,
    probabilities: probs,
    counts,
    bloch: blochAcc,
    stochastic: true,
    trajectories,
  };
}

function sampleKeyFrom(p: Float64Array, n: number, rand: () => number): string {
  let acc = 0;
  const r = rand();
  for (let i = 0; i < p.length; i++) {
    acc += p[i]!;
    if (r <= acc) return i.toString(2).padStart(n, '0');
  }
  return (p.length - 1).toString(2).padStart(n, '0');
}

/** Full unitary of a circuit, by evolving each basis state. Only for small n. */
export function circuitUnitary(circuit: Circuit, bindings: Record<string, number> = {}): CMatrix {
  const n = circuit.qubits;
  if (n > 10) throw new IRError('circuitUnitary is limited to 10 qubits');
  for (const op of circuit.ops) {
    if (GATES[op.gate]?.category === 'nonunitary' && op.gate !== 'barrier') {
      throw new IRError(`circuit contains non-unitary op '${op.gate}'`, op.id);
    }
  }
  const N = 1 << n;
  const d = new Float64Array(2 * N * N);
  for (let col = 0; col < N; col++) {
    const state = new Float64Array(2 * N);
    state[2 * col] = 1;
    const stub: Circuit = { ...circuit, ops: circuit.ops };
    const { state: out } = runOnceFromState(stub, state, bindings);
    for (let row = 0; row < N; row++) {
      d[2 * (row * N + col)] = out[2 * row]!;
      d[2 * (row * N + col) + 1] = out[2 * row + 1]!;
    }
  }
  return { n: N, d };
}

function runOnceFromState(
  circuit: Circuit,
  state: Float64Array,
  bindings: Record<string, number>,
): { state: Float64Array } {
  const n = circuit.qubits;
  for (const op of circuit.ops) {
    if (op.gate === 'barrier') continue;
    const def = gate(op.gate);
    const params = resolveParams(op.params, bindings);
    let targets = op.targets;
    let controls = op.controls ?? [];
    if (def.controlledForm && def.controlledForm.controls >= 0 && def.matrix === undefined) {
      const nc = def.controlledForm.controls;
      controls = [...controls, ...op.targets.slice(0, nc)];
      targets = op.targets.slice(nc);
    }
    const effective = def.controlledForm && def.matrix === undefined ? gate(def.controlledForm.base) : def;
    if (!effective.matrix) throw new IRError(`gate '${op.gate}' has no matrix`, op.id);
    applyMatrix(state, n, targets, controls, effective.matrix(params));
  }
  return { state };
}

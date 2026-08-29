import { describe, it, expect } from 'vitest';
import {
  simulate, emptyCircuit, blochVectors, circuitUnitary, equalUpToPhase, gate,
  bellState, ghzState, wState, qft, grover, groverIterations, deutschJozsa,
  bernsteinVazirani, teleportation, superdenseCoding, phaseEstimation, chsh,
  type Circuit, type Op,
} from '../src/index.js';
import { expectAmp } from './helpers.js';

const S2 = Math.SQRT1_2;
const c = (name: string, q: number, ops: Op[], cl = q): Circuit => ({
  ...emptyCircuit(q, cl, name), ops,
});

describe('single qubit', () => {
  it('H on |0> gives an equal superposition', () => {
    const r = simulate(c('h', 1, [{ id: '1', gate: 'h', targets: [0] }]));
    expectAmp(r.statevector!, '0', S2);
    expectAmp(r.statevector!, '1', S2);
  });

  it('Bloch vector of H|0> points along +x', () => {
    const r = simulate(c('h', 1, [{ id: '1', gate: 'h', targets: [0] }]));
    const b = r.bloch[0]!;
    expect(b.x).toBeCloseTo(1, 9);
    expect(b.y).toBeCloseTo(0, 9);
    expect(b.z).toBeCloseTo(0, 9);
    expect(b.purity).toBeCloseTo(1, 9);
  });

  it('S after H points along +y', () => {
    const r = simulate(c('hs', 1, [
      { id: '1', gate: 'h', targets: [0] },
      { id: '2', gate: 's', targets: [0] },
    ]));
    const b = r.bloch[0]!;
    expect(b.x).toBeCloseTo(0, 9);
    expect(b.y).toBeCloseTo(1, 9);
  });

  it('Rx(pi) equals X up to global phase', () => {
    const rx = c('rx', 1, [{ id: '1', gate: 'rx', targets: [0], params: [Math.PI] }]);
    const x = c('x', 1, [{ id: '1', gate: 'x', targets: [0] }]);
    expect(equalUpToPhase(circuitUnitary(rx), circuitUnitary(x))).toBe(true);
  });
});

describe('entanglement', () => {
  it('Bell Phi+ has amplitude 1/sqrt(2) on |00> and |11> only', () => {
    const r = simulate(bellState(0));
    expectAmp(r.statevector!, '00', S2);
    expectAmp(r.statevector!, '01', 0);
    expectAmp(r.statevector!, '10', 0);
    expectAmp(r.statevector!, '11', S2);
  });

  it('all four Bell states are orthonormal and maximally entangled', () => {
    for (const k of [0, 1, 2, 3] as const) {
      const r = simulate(bellState(k));
      const total = r.probabilities.reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 12);
      for (const b of r.bloch) expect(b.purity).toBeCloseTo(0, 9);
    }
  });

  it('GHZ on 5 qubits has half the weight on each extreme', () => {
    const r = simulate(ghzState(5));
    expect(r.probabilities[0]).toBeCloseTo(0.5, 12);
    expect(r.probabilities[31]).toBeCloseTo(0.5, 12);
    expect(r.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('W state has equal weight on the three single-excitation states', () => {
    const r = simulate(wState());
    const third = 1 / 3;
    expect(r.probabilities[0b100]).toBeCloseTo(third, 10);
    expect(r.probabilities[0b010]).toBeCloseTo(third, 10);
    expect(r.probabilities[0b001]).toBeCloseTo(third, 10);
    expect(r.probabilities[0b000]).toBeCloseTo(0, 10);
    expect(r.probabilities[0b111]).toBeCloseTo(0, 10);
  });
});

describe('QFT', () => {
  it('matches the DFT matrix on 3 qubits', () => {
    const n = 3;
    const N = 1 << n;
    const u = circuitUnitary(qft(n));
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        const angle = (2 * Math.PI * j * k) / N;
        const re = Math.cos(angle) / Math.sqrt(N);
        const im = Math.sin(angle) / Math.sqrt(N);
        const idx = 2 * (j * N + k);
        expect(Math.abs(u.d[idx]! - re), `Re[${j}][${k}]`).toBeLessThan(1e-9);
        expect(Math.abs(u.d[idx + 1]! - im), `Im[${j}][${k}]`).toBeLessThan(1e-9);
      }
    }
  });
});

describe('algorithms', () => {
  it('Grover finds the marked item with high probability', () => {
    for (const nq of [2, 3, 4]) {
      for (const marked of [0, 1, (1 << nq) - 1]) {
        const r = simulate(grover(nq, marked));
        const p = r.probabilities[marked]!;
        expect(p, `n=${nq} marked=${marked} iters=${groverIterations(nq)} p=${p}`).toBeGreaterThan(0.6);
        const best = r.probabilities.indexOf(Math.max(...r.probabilities));
        expect(best).toBe(marked);
      }
    }
  });

  it('Grover on 3 qubits with 2 iterations reaches about 0.945', () => {
    const r = simulate(grover(3, 5, 2));
    expect(r.probabilities[5]!).toBeGreaterThan(0.94);
    expect(r.probabilities[5]!).toBeLessThan(0.95);
  });

  it('Deutsch-Jozsa distinguishes constant from balanced', () => {
    const constant = simulate(deutschJozsa(3, 'constant'), { shots: 512, seed: 7 });
    expect(Object.keys(constant.counts!)).toEqual(['000']);
    const balanced = simulate(deutschJozsa(3, 'balanced'), { shots: 512, seed: 7 });
    expect(Object.keys(balanced.counts!)).toEqual(['111']);
  });

  it('Bernstein-Vazirani recovers the secret in one query', () => {
    for (const secret of ['101', '1101', '0110']) {
      const r = simulate(bernsteinVazirani(secret), { shots: 256, seed: 3 });
      const keys = Object.keys(r.counts!);
      expect(keys.length).toBe(1);
      expect(keys[0]).toBe(secret);
    }
  });

  it('teleportation moves an arbitrary state to qubit 2', () => {
    const prepare: Op[] = [
      { id: 'p1', gate: 'ry', targets: [0], params: [0.9] },
      { id: 'p2', gate: 'rz', targets: [0], params: [0.4] },
    ];
    const circuit = teleportation(prepare);
    // Run many trajectories; qubit 2's Bloch vector must match the input state.
    const r = simulate(circuit, { shots: 4000, seed: 11 });
    const target = r.bloch[2]!;
    const expectedZ = Math.cos(0.9);
    const expectedX = Math.sin(0.9) * Math.cos(0.4);
    const expectedY = Math.sin(0.9) * Math.sin(0.4);
    expect(target.z).toBeCloseTo(expectedZ, 2);
    expect(target.x).toBeCloseTo(expectedX, 2);
    expect(target.y).toBeCloseTo(expectedY, 2);
  });

  it('superdense coding transmits two bits over one qubit', () => {
    for (const msg of ['00', '01', '10', '11'] as const) {
      const r = simulate(superdenseCoding(msg), { shots: 200, seed: 5 });
      const keys = Object.keys(r.counts!);
      expect(keys.length, `message ${msg} was not deterministic`).toBe(1);
      expect(keys[0]).toBe(msg);
    }
  });

  it('phase estimation recovers a 3-bit phase exactly', () => {
    // phase = 0.625 = 0.101 in binary, exactly representable on 3 counting qubits
    const r = simulate(phaseEstimation(3, 0.625), { shots: 400, seed: 2 });
    const keys = Object.entries(r.counts!).sort((a, b) => b[1] - a[1]);
    expect(keys[0]![0]).toBe('101');
  });

  it('CHSH at the optimal angles beats the classical bound', () => {
    // Optimal angles: Alice 0, pi/4; Bob pi/8, -pi/8
    const settings: [number, number][] = [
      [0, Math.PI / 8], [0, -Math.PI / 8],
      [Math.PI / 4, Math.PI / 8], [Math.PI / 4, -Math.PI / 8],
    ];
    const correlations = settings.map(([a, b]) => {
      const r = simulate(chsh(a, b), { shots: 20000, seed: 42 });
      let e = 0;
      for (const [k, v] of Object.entries(r.counts!)) {
        const parity = (k[0] === k[1]) ? 1 : -1;
        e += parity * v;
      }
      return e / 20000;
    });
    // settings are [ab, ab', a'b, a'b'] so S = E(ab) + E(ab') + E(a'b) - E(a'b')
    const S = correlations[0]! + correlations[1]! + correlations[2]! - correlations[3]!;
    expect(Math.abs(S)).toBeGreaterThan(2.0);
    expect(Math.abs(S)).toBeLessThan(2.9);
  });
});

describe('measurement and classical control', () => {
  it('measuring |+> gives roughly balanced counts', () => {
    const circ = c('m', 1, [
      { id: '1', gate: 'h', targets: [0] },
      { id: '2', gate: 'measure', targets: [0], cbits: [0] },
    ]);
    const r = simulate(circ, { shots: 4000, seed: 1 });
    const zeros = r.counts!['0'] ?? 0;
    expect(zeros / 4000).toBeGreaterThan(0.45);
    expect(zeros / 4000).toBeLessThan(0.55);
  });

  it('reset returns a qubit to |0>', () => {
    const circ = c('r', 1, [
      { id: '1', gate: 'x', targets: [0] },
      { id: '2', gate: 'reset', targets: [0] },
      { id: '3', gate: 'measure', targets: [0], cbits: [0] },
    ]);
    const r = simulate(circ, { shots: 200, seed: 4 });
    expect(Object.keys(r.counts!)).toEqual(['0']);
  });

  it('a classically conditioned gate only fires on the right outcome', () => {
    const circ = c('cond', 2, [
      { id: '1', gate: 'x', targets: [0] },
      { id: '2', gate: 'measure', targets: [0], cbits: [0] },
      { id: '3', gate: 'x', targets: [1], condition: { bits: [0], value: 1 } },
      { id: '4', gate: 'measure', targets: [1], cbits: [1] },
    ]);
    const r = simulate(circ, { shots: 100, seed: 6 });
    expect(Object.keys(r.counts!)).toEqual(['11']);
  });
});

describe('noise', () => {
  it('depolarising noise degrades Bell fidelity monotonically', () => {
    const fidelities = [0, 0.02, 0.08, 0.2].map((p) => {
      const r = simulate(bellState(0), { shots: 3000, seed: 9, noise: { depolarising1: p, depolarising2: p } });
      return r.probabilities[0]! + r.probabilities[3]!;
    });
    for (let i = 1; i < fidelities.length; i++) {
      expect(fidelities[i]!).toBeLessThan(fidelities[i - 1]! + 1e-9);
    }
    expect(fidelities[0]!).toBeCloseTo(1, 6);
    expect(fidelities[3]!).toBeLessThan(0.95);
  });

  it('readout error flips reported bits at roughly the stated rate', () => {
    const circ = c('ro', 1, [{ id: '1', gate: 'measure', targets: [0], cbits: [0] }]);
    const r = simulate(circ, { shots: 5000, seed: 13, noise: { readout: 0.1 } });
    const ones = (r.counts!['1'] ?? 0) / 5000;
    expect(ones).toBeGreaterThan(0.08);
    expect(ones).toBeLessThan(0.12);
  });
});

describe('admission control', () => {
  it('refuses circuits beyond the qubit cap instead of hanging', () => {
    expect(() => simulate(emptyCircuit(25, 0), { maxQubits: 20 })).toThrow(/capped at 20/);
  });
});

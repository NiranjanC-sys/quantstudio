import { describe, it, expect } from 'vitest';
import {
  toQasm3, toQiskit, toCirq, toPennyLane, fromQasm3, emit, DIALECTS,
  bellState, ghzState, qft, teleportation, grover, phaseEstimation,
  circuitUnitary, equalUpToPhase, canonicalString, circuitHash, canonicalise,
  emptyCircuit, simulate, type Circuit, type Op,
} from '../src/index.js';

describe('OpenQASM 3 emission', () => {
  it('emits a well formed header and body', () => {
    const q = toQasm3(bellState(0));
    expect(q).toContain('OPENQASM 3.0;');
    expect(q).toContain('include "stdgates.inc";');
    expect(q).toContain('qubit[2] q;');
    expect(q).toContain('bit[2] c;');
    expect(q).toContain('h q[0];');
    expect(q).toContain('cx q[0], q[1];');
  });

  it('renders angles as multiples of pi where possible', () => {
    const c: Circuit = { ...emptyCircuit(1, 0), ops: [{ id: '1', gate: 'rz', targets: [0], params: [Math.PI / 4] }] };
    expect(toQasm3(c)).toContain('rz(pi/4) q[0];');
  });

  it('declares symbolic parameters as inputs', () => {
    const c: Circuit = { ...emptyCircuit(1, 0), ops: [{ id: '1', gate: 'ry', targets: [0], params: [{ symbol: 'theta' }] }] };
    const q = toQasm3(c);
    expect(q).toContain('input float[64] theta;');
    expect(q).toContain('ry(theta) q[0];');
  });

  it('uses ctrl @ for controls with no named alias', () => {
    const c: Circuit = { ...emptyCircuit(4, 0), ops: [{ id: '1', gate: 'x', targets: [3], controls: [0, 1, 2] }] };
    expect(toQasm3(c)).toContain('ctrl @ ctrl @ ctrl @ x q[0], q[1], q[2], q[3];');
  });
});

describe('OpenQASM 3 round trip', () => {
  const cases: [string, Circuit][] = [
    ['bell', bellState(0)],
    ['ghz4', ghzState(4)],
    ['qft3', qft(3)],
    ['grover3', grover(3, 5)],
    ['qpe3', phaseEstimation(3, 0.625)],
    ['teleport', teleportation([{ id: 'p', gate: 'ry', targets: [0], params: [0.7] }])],
  ];

  for (const [name, circuit] of cases) {
    it(`${name} survives IR -> QASM -> IR`, () => {
      const parsed = fromQasm3(toQasm3(circuit));
      expect(parsed.qubits).toBe(circuit.qubits);
      expect(canonicalString(parsed)).toBe(canonicalString(circuit));
    });
  }

  it('a round trip preserves simulation results exactly', () => {
    const original = qft(4);
    const parsed = fromQasm3(toQasm3(original));
    const a = simulate(original).statevector!;
    const b = simulate(parsed).statevector!;
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(1e-12);
  });

  it('reports the line of a syntax error', () => {
    const bad = 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nzzz q[0];\n';
    expect(() => fromQasm3(bad)).toThrow(/unknown gate 'zzz' \(line 4/);
  });

  it('rejects an unbound identifier rather than guessing', () => {
    const bad = 'OPENQASM 3.0;\nqubit[1] q;\nrz(alpha) q[0];\n';
    expect(() => fromQasm3(bad)).toThrow(/unknown identifier 'alpha'/);
  });

  it('parses arithmetic in angles', () => {
    const src = 'OPENQASM 3.0;\nqubit[1] q;\nrz(pi/8) q[0];\n';
    const c = fromQasm3(src);
    expect(c.ops[0]!.params![0]).toBeCloseTo(Math.PI / 8, 12);
  });
});

describe('SDK emitters', () => {
  it('Qiskit output mirrors qubit indices for little-endian', () => {
    const py = toQiskit(bellState(0));
    expect(py).toContain('qc = QuantumCircuit(2, 2)');
    // qubit 0 (ours) becomes qubit 1 (Qiskit) on a 2-qubit circuit
    expect(py).toContain('qc.h(1)');
    expect(py).toContain('qc.cx(1, 0)');
  });

  it('Cirq output keeps our indices unchanged', () => {
    const py = toCirq(bellState(0));
    expect(py).toContain('cirq.LineQubit.range(2)');
    expect(py).toContain('cirq.H.on(qubits[0])');
    expect(py).toContain('cirq.CNOT.on(qubits[0], qubits[1])');
  });

  it('PennyLane output is a QNode returning the state', () => {
    const py = toPennyLane(bellState(0));
    expect(py).toContain('@qml.qnode(dev)');
    expect(py).toContain('qml.Hadamard(wires=0)');
    expect(py).toContain('qml.CNOT(wires=[0,1])');
    expect(py).toContain('return qml.state()');
  });

  it('PennyLane threads symbolic parameters into the function signature', () => {
    const c: Circuit = { ...emptyCircuit(1, 0), ops: [{ id: '1', gate: 'ry', targets: [0], params: [{ symbol: 'theta' }] }] };
    expect(toPennyLane(c)).toContain('def circuit(theta):');
  });

  it('every dialect emits non-empty source for every reference circuit', () => {
    for (const { id } of DIALECTS) {
      for (const circuit of [bellState(0), ghzState(3), qft(3), grover(2, 3)]) {
        const src = emit(circuit, id);
        expect(src.length, `${id} produced nothing`).toBeGreaterThan(40);
        expect(src, `${id} left an unsupported gate`).not.toContain('unsupported in this emitter');
      }
    }
  });
});

describe('canonical form and hashing', () => {
  it('gives the same hash for commuting reorders', () => {
    const a: Circuit = { ...emptyCircuit(2, 0), ops: [
      { id: '1', gate: 'h', targets: [0] },
      { id: '2', gate: 'x', targets: [1] },
    ] };
    const b: Circuit = { ...emptyCircuit(2, 0), ops: [
      { id: '9', gate: 'x', targets: [1] },
      { id: '8', gate: 'h', targets: [0] },
    ] };
    expect(circuitHash(a)).toBe(circuitHash(b));
  });

  it('gives different hashes for genuinely different circuits', () => {
    expect(circuitHash(bellState(0))).not.toBe(circuitHash(bellState(1)));
    expect(circuitHash(qft(3))).not.toBe(circuitHash(qft(4)));
  });

  it('normalises controlled aliases to base plus controls', () => {
    const withAlias: Circuit = { ...emptyCircuit(2, 0), ops: [{ id: '1', gate: 'cx', targets: [0, 1] }] };
    const explicit: Circuit = { ...emptyCircuit(2, 0), ops: [{ id: '2', gate: 'x', targets: [1], controls: [0] }] };
    expect(circuitHash(withAlias)).toBe(circuitHash(explicit));
    expect(canonicalise(withAlias).ops[0]!.gate).toBe('x');
  });

  it('ignores barriers, names and op ids', () => {
    const a: Circuit = { ...emptyCircuit(2, 0, 'one'), ops: [
      { id: 'x', gate: 'h', targets: [0] },
      { id: 'y', gate: 'barrier', targets: [0, 1] },
      { id: 'z', gate: 'x', targets: [1], controls: [0] },
    ] };
    const b: Circuit = { ...emptyCircuit(2, 0, 'two'), ops: [
      { id: 'q', gate: 'h', targets: [0] },
      { id: 'r', gate: 'x', targets: [1], controls: [0] },
    ] };
    expect(circuitHash(a)).toBe(circuitHash(b));
  });

  it('is sensitive to angle differences beyond 1e-12', () => {
    const mk = (t: number): Circuit => ({ ...emptyCircuit(1, 0), ops: [{ id: '1', gate: 'rz', targets: [0], params: [t] }] });
    expect(circuitHash(mk(0.5))).toBe(circuitHash(mk(0.5 + 1e-15)));
    expect(circuitHash(mk(0.5))).not.toBe(circuitHash(mk(0.5001)));
  });
});

describe('inverse circuits', () => {
  it('a circuit followed by its inverse is the identity', async () => {
    const { inverse } = await import('../src/analysis.js');
    for (const circuit of [qft(3), ghzState(3), bellState(2)]) {
      const combined: Circuit = { ...circuit, ops: [...circuit.ops, ...inverse(circuit).ops] };
      const u = circuitUnitary(combined);
      const { identity } = await import('../src/complex.js');
      expect(equalUpToPhase(u, identity(u.n)), `${circuit.name} inverse failed`).toBe(true);
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  metrics, validate, layerize, moments, emptyCircuit,
  place, removeOp, addControl, setQubits, defaultParams,
  bellState, ghzState, wState, qft, grover, deutschJozsa, bernsteinVazirani,
  teleportation, superdenseCoding, phaseEstimation, qaoaMaxCut, chsh, bitFlipCode,
  type Circuit,
} from '../src/index.js';

describe('metrics', () => {
  it('counts a Bell circuit correctly', () => {
    const m = metrics(bellState(0));
    expect(m.size).toBe(2);
    expect(m.depth).toBe(2);
    expect(m.singleQubitGates).toBe(1);
    expect(m.twoQubitGates).toBe(1);
    expect(m.clifford).toBe(true);
    expect(m.tCount).toBe(0);
    expect(m.activeQubits).toBe(2);
  });

  it('computes depth as the critical path, not the op count', () => {
    // Two gates on disjoint qubits happen in the same layer.
    const c: Circuit = { ...emptyCircuit(2, 0), ops: [
      { id: '1', gate: 'h', targets: [0] },
      { id: '2', gate: 'h', targets: [1] },
    ] };
    expect(metrics(c).size).toBe(2);
    expect(metrics(c).depth).toBe(1);
  });

  it('GHZ depth grows linearly in the qubit count', () => {
    expect(metrics(ghzState(5)).depth).toBe(5);
    expect(metrics(ghzState(5)).twoQubitGates).toBe(4);
  });

  it('marks non-Clifford circuits', () => {
    const c: Circuit = { ...emptyCircuit(1, 0), ops: [{ id: '1', gate: 't', targets: [0] }] };
    expect(metrics(c).clifford).toBe(false);
    expect(metrics(c).tCount).toBe(1);
  });

  it('knows that adding controls breaks Clifford membership', () => {
    const mk = (gate: string, targets: number[], controls?: number[]): Circuit => ({
      ...emptyCircuit(3, 0),
      ops: [{ id: '1', gate, targets, ...(controls ? { controls } : {}) }],
    });
    // Clifford
    expect(metrics(mk('z', [0])).clifford).toBe(true);
    expect(metrics(mk('z', [1], [0])).clifford).toBe(true);   // CZ
    expect(metrics(mk('x', [1], [0])).clifford).toBe(true);   // CX
    expect(metrics(mk('y', [1], [0])).clifford).toBe(true);   // CY
    expect(metrics(mk('swap', [0, 1])).clifford).toBe(true);
    // Not Clifford
    expect(metrics(mk('z', [2], [0, 1])).clifford).toBe(false);   // CCZ
    expect(metrics(mk('x', [2], [0, 1])).clifford).toBe(false);   // Toffoli
    expect(metrics(mk('h', [1], [0])).clifford).toBe(false);      // CH
    expect(metrics(mk('s', [1], [0])).clifford).toBe(false);      // CS
    expect(metrics(mk('swap', [1, 2], [0])).clifford).toBe(false); // Fredkin
  });

  it('a Grover circuit is not Clifford, because its oracle is not', () => {
    expect(metrics(grover(3, 5)).clifford).toBe(false);
  });

  it('reports two-qubit gate count for a Grover circuit', () => {
    const m = metrics(grover(3, 5));
    expect(m.multiQubitGates).toBeGreaterThan(0);
    expect(m.depth).toBeGreaterThan(m.qubits);
  });
});

describe('layering', () => {
  it('puts independent gates in one moment', () => {
    const c: Circuit = { ...emptyCircuit(3, 0), ops: [
      { id: '1', gate: 'h', targets: [0] },
      { id: '2', gate: 'h', targets: [1] },
      { id: '3', gate: 'h', targets: [2] },
      { id: '4', gate: 'x', targets: [1], controls: [0] },
    ] };
    expect(layerize(c)).toEqual([0, 0, 0, 1]);
    expect(moments(c).length).toBe(2);
    expect(moments(c)[0]!.length).toBe(3);
  });

  it('a barrier fences every wire', () => {
    const c: Circuit = { ...emptyCircuit(2, 0), ops: [
      { id: '1', gate: 'h', targets: [0] },
      { id: '2', gate: 'barrier', targets: [0, 1] },
      { id: '3', gate: 'h', targets: [1] },
    ] };
    const l = layerize(c);
    expect(l[2]).toBeGreaterThan(l[0]!);
  });
});

describe('validation', () => {
  it('accepts a valid circuit', () => {
    expect(validate(qft(3)).filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('rejects an out-of-range qubit', () => {
    const c: Circuit = { ...emptyCircuit(2, 0), ops: [{ id: '1', gate: 'h', targets: [5] }] };
    expect(validate(c).some((i) => /out of range/.test(i.message))).toBe(true);
  });

  it('rejects a gate applied twice to the same qubit', () => {
    const c: Circuit = { ...emptyCircuit(2, 0), ops: [{ id: '1', gate: 'x', targets: [0], controls: [0] }] };
    expect(validate(c).some((i) => /same qubit twice/.test(i.message))).toBe(true);
  });

  it('rejects a wrong parameter count', () => {
    const c: Circuit = { ...emptyCircuit(1, 0), ops: [{ id: '1', gate: 'rz', targets: [0] }] };
    expect(validate(c).some((i) => /expects 1 parameter/.test(i.message))).toBe(true);
  });

  it('warns about unused qubits', () => {
    const c: Circuit = { ...emptyCircuit(3, 0), ops: [{ id: '1', gate: 'h', targets: [0] }] };
    expect(validate(c).some((i) => i.severity === 'warning' && /never used/.test(i.message))).toBe(true);
  });

  it('accepts a barrier spanning every wire', () => {
    const c: Circuit = { ...emptyCircuit(4, 0), ops: [
      { id: '1', gate: 'h', targets: [0] },
      { id: '2', gate: 'h', targets: [1] },
      { id: '3', gate: 'h', targets: [2] },
      { id: '4', gate: 'h', targets: [3] },
      { id: '5', gate: 'barrier', targets: [0, 1, 2, 3] },
    ] };
    expect(validate(c).filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('validates every reference circuit in the catalog', () => {
    const circuits: Circuit[] = [
      bellState(0), ghzState(4), wState(), qft(3), grover(3, 5),
      deutschJozsa(3, 'balanced'), bernsteinVazirani('1011'),
      teleportation([{ id: 'p', gate: 'ry', targets: [0], params: [0.9] }]),
      superdenseCoding('10'), phaseEstimation(3, 0.625),
      qaoaMaxCut(4, [[0, 1], [1, 2], [2, 3]], 0.4, 0.8), chsh(0, Math.PI / 8),
      bitFlipCode(1),
    ];
    for (const c of circuits) {
      const errors = validate(c).filter((i) => i.severity === 'error');
      expect(errors.map((e) => e.message), `${c.name} failed validation`).toEqual([]);
    }
  });

  it('requires a classical bit for measure', () => {
    const c: Circuit = { ...emptyCircuit(1, 1), ops: [{ id: '1', gate: 'measure', targets: [0] }] };
    expect(validate(c).some((i) => /needs a classical bit/.test(i.message))).toBe(true);
  });
});

describe('builder edits', () => {
  it('placing a gate gives it valid default parameters', () => {
    const c = place(emptyCircuit(2, 2), { gate: 'rz', targets: [0] });
    expect(validate(c).filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(c.ops[0]!.params).toHaveLength(1);
  });

  it('defaultParams never produces an invalid gate', () => {
    for (const g of ['rx', 'ry', 'rz', 'p', 'u', 'crx', 'cp']) {
      expect(defaultParams(g).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('removing a gate leaves the rest intact', () => {
    let c = place(emptyCircuit(2, 2), { gate: 'h', targets: [0] });
    c = place(c, { gate: 'x', targets: [1] });
    const id = c.ops[0]!.id;
    c = removeOp(c, id);
    expect(c.ops).toHaveLength(1);
    expect(c.ops[0]!.gate).toBe('x');
  });

  it('adding a control turns X into CNOT', () => {
    let c = place(emptyCircuit(2, 2), { gate: 'x', targets: [1] });
    c = addControl(c, c.ops[0]!.id, 0);
    expect(c.ops[0]!.controls).toEqual([0]);
    expect(validate(c).filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('shrinking the register drops gates that would dangle', () => {
    let c = place(emptyCircuit(4, 4), { gate: 'h', targets: [3] });
    c = place(c, { gate: 'h', targets: [0] });
    c = setQubits(c, 2);
    expect(c.qubits).toBe(2);
    expect(c.ops).toHaveLength(1);
    expect(validate(c).filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('a control cannot be added onto the gate own target', () => {
    let c = place(emptyCircuit(2, 2), { gate: 'x', targets: [1] });
    c = addControl(c, c.ops[0]!.id, 1);
    expect(c.ops[0]!.controls).toBeUndefined();
  });
});

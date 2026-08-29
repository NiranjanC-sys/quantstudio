import { describe, it, expect } from 'vitest';
import { GATES, GATE_KEYS, gate, isUnitary, multiply, dagger, identity, maxAbsDiff, equalUpToPhase } from '../src/index.js';

const SAMPLE_PARAMS = [0.7, 1.3, -0.4];

describe('gate registry', () => {
  it('exposes at least 38 gates', () => {
    expect(GATE_KEYS.length).toBeGreaterThanOrEqual(38);
  });

  it('every unitary gate has a unitary matrix', () => {
    for (const key of GATE_KEYS) {
      const def = GATES[key]!;
      if (!def.matrix) continue;
      const m = def.matrix(SAMPLE_PARAMS.slice(0, def.paramNames.length));
      expect(m.n, `${key} matrix size`).toBe(1 << def.arity);
      expect(isUnitary(m), `${key} is not unitary`).toBe(true);
    }
  });

  it('declared inverses actually invert', () => {
    for (const key of GATE_KEYS) {
      const def = GATES[key]!;
      if (!def.matrix || !def.inverse) continue;
      const params = SAMPLE_PARAMS.slice(0, def.paramNames.length);
      const inv = gate(def.inverse.gate);
      if (!inv.matrix) continue;
      const invParams = def.inverse.params ? def.inverse.params(params) : params;
      const product = multiply(def.matrix(params), inv.matrix(invParams));
      expect(equalUpToPhase(product, identity(product.n)), `${key} inverse failed`).toBe(true);
    }
  });

  it('matches known matrices exactly', () => {
    const h = gate('h').matrix!([]);
    expect(h.d[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(h.d[6]).toBeCloseTo(-Math.SQRT1_2, 12);

    // CNOT with control first (big-endian): |10> -> |11>, |11> -> |10>
    const cx = gate('cx').matrix!([]);
    const expected = [
      1, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 1, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 1, 0, 0, 0,
    ];
    expect(Array.from(cx.d)).toEqual(expected);
  });

  it('T squared is S', () => {
    const t = gate('t').matrix!([]);
    const s = gate('s').matrix!([]);
    expect(maxAbsDiff(multiply(t, t), s)).toBeLessThan(1e-12);
  });

  it('sqrt(X) squared is X', () => {
    const sx = gate('sx').matrix!([]);
    const x = gate('x').matrix!([]);
    expect(equalUpToPhase(multiply(sx, sx), x)).toBe(true);
  });

  it('dagger of a unitary is its inverse', () => {
    const u = gate('u').matrix!([0.3, 1.1, -0.9]);
    expect(maxAbsDiff(multiply(u, dagger(u)), identity(2))).toBeLessThan(1e-12);
  });
});

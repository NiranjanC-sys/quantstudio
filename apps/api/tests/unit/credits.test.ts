/**
 * The §7 credit formula: `ceil(2^(n-16)) * (shots/1024) * backend_multiplier`.
 *
 * The precedence matters and is easy to get wrong: the `ceil` binds to the
 * exponential term alone, so a 4-qubit circuit with 1,048,576 shots is priced by
 * its shot count (1 * 1024 * 1 = 1024 credits) rather than being rounded to
 * nothing. These tests pin the formula term by term.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/errors.js';
import { BACKEND_MULTIPLIERS, creditCost } from '../../src/entitlements/credits.js';

/** The formula as written in system-design, evaluated independently. */
function reference(qubits: number, shots: number, multiplier: number): number {
  return Math.ceil(Math.pow(2, qubits - 16)) * (shots / 1024) * multiplier;
}

describe('creditCost', () => {
  it('is exactly the formula from §7', () => {
    for (const qubits of [1, 8, 15, 16, 17, 20, 24, 28, 30, 32]) {
      for (const shots of [1, 128, 1024, 4096, 65_536]) {
        for (const [backend, multiplier] of Object.entries(BACKEND_MULTIPLIERS)) {
          const quote = creditCost({
            qubits,
            shots,
            backend: backend as keyof typeof BACKEND_MULTIPLIERS,
          });
          expect(quote.rawCost).toBeCloseTo(reference(qubits, shots, multiplier), 10);
          expect(quote.backendMultiplier).toBe(multiplier);
        }
      }
    }
  });

  it('floors the exponential term at 1 below 16 qubits', () => {
    // ceil(2^-15) = 1, so the price is driven entirely by shots.
    expect(creditCost({ qubits: 1, shots: 1024, backend: 'statevector' }).rawCost).toBe(1);
    expect(creditCost({ qubits: 15, shots: 1024, backend: 'statevector' }).rawCost).toBe(1);
    expect(creditCost({ qubits: 16, shots: 1024, backend: 'statevector' }).rawCost).toBe(1);
    // …and a small circuit with a huge shot count is still expensive.
    expect(creditCost({ qubits: 4, shots: 1_048_576, backend: 'statevector' }).credits).toBe(1024);
  });

  it('doubles with every qubit above 16', () => {
    const at16 = creditCost({ qubits: 16, shots: 1024, backend: 'statevector' }).rawCost;
    const at17 = creditCost({ qubits: 17, shots: 1024, backend: 'statevector' }).rawCost;
    const at20 = creditCost({ qubits: 20, shots: 1024, backend: 'statevector' }).rawCost;

    expect(at17).toBe(at16 * 2);
    expect(at20).toBe(at16 * 16);
    // A 28-qubit Pro-ceiling job: 2^12 = 4096 credits at one shot-unit.
    expect(creditCost({ qubits: 28, shots: 1024, backend: 'statevector' }).credits).toBe(4096);
  });

  it('scales linearly in shots, in units of 1024', () => {
    const base = creditCost({ qubits: 20, shots: 1024, backend: 'statevector' }).rawCost;
    expect(creditCost({ qubits: 20, shots: 2048, backend: 'statevector' }).rawCost).toBe(base * 2);
    expect(creditCost({ qubits: 20, shots: 512, backend: 'statevector' }).rawCost).toBe(base / 2);
  });

  it('applies the backend multiplier', () => {
    const shape = { qubits: 18, shots: 1024 } as const;
    const statevector = creditCost({ ...shape, backend: 'statevector' }).rawCost;

    expect(creditCost({ ...shape, backend: 'density_matrix' }).rawCost).toBe(statevector * 4);
    expect(creditCost({ ...shape, backend: 'tensor_network' }).rawCost).toBe(statevector * 2);
    expect(creditCost({ ...shape, backend: 'stabilizer' }).rawCost).toBe(statevector * 0.25);
    expect(creditCost({ ...shape, backend: 'hardware' }).rawCost).toBe(statevector * 25);
  });

  it('accepts a negotiated multiplier that overrides the table', () => {
    const quote = creditCost({
      qubits: 18,
      shots: 1024,
      backend: 'hardware',
      backendMultiplier: 3.5,
    });
    expect(quote.backendMultiplier).toBe(3.5);
    expect(quote.rawCost).toBe(4 * 3.5);
  });

  it('debits a whole number of credits, and never zero for a real job', () => {
    // 2 qubits, 1 shot, stabilizer: raw cost is 1 * (1/1024) * 0.25 ≈ 0.00024.
    const tiny = creditCost({ qubits: 2, shots: 1, backend: 'stabilizer' });
    expect(tiny.rawCost).toBeLessThan(1);
    expect(tiny.credits).toBe(1);

    const fractional = creditCost({ qubits: 17, shots: 1536, backend: 'statevector' });
    expect(fractional.rawCost).toBe(3);
    expect(Number.isInteger(fractional.credits)).toBe(true);

    const rounded = creditCost({ qubits: 17, shots: 1025, backend: 'statevector' });
    expect(rounded.rawCost).toBeGreaterThan(2);
    expect(rounded.credits).toBe(3);
  });

  it('stays inside safe-integer range at the Campus ceiling', () => {
    const worst = creditCost({ qubits: 32, shots: 1_048_576, backend: 'hardware' });
    expect(Number.isFinite(worst.credits)).toBe(true);
    expect(worst.credits).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(worst.credits).toBe(65_536 * 1024 * 25);
  });

  it('rejects nonsensical inputs with a typed validation problem', () => {
    for (const bad of [
      { qubits: 0, shots: 1024 },
      { qubits: -3, shots: 1024 },
      { qubits: 1.5, shots: 1024 },
    ]) {
      expect(() => creditCost({ ...bad, backend: 'statevector' })).toThrow(ApiError);
    }
    for (const bad of [
      { qubits: 8, shots: 0 },
      { qubits: 8, shots: -1 },
      { qubits: 8, shots: 10.5 },
    ]) {
      expect(() => creditCost({ ...bad, backend: 'statevector' })).toThrow(ApiError);
    }

    try {
      creditCost({ qubits: 0, shots: 1, backend: 'statevector' });
      expect.unreachable('creditCost should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('validation-failed');
      expect((error as ApiError).status).toBe(400);
    }
  });

  it('echoes the inputs back so a quote can be shown to the learner', () => {
    const quote = creditCost({ qubits: 22, shots: 8192, backend: 'tensor_network' });
    expect(quote.qubits).toBe(22);
    expect(quote.shots).toBe(8192);
    expect(quote.backend).toBe('tensor_network');
  });
});

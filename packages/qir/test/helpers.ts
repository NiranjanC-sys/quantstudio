import { expect } from 'vitest';
import { simulate, type Circuit } from '../src/index.js';

export function amp(sv: Float64Array, i: number): [number, number] {
  return [sv[2 * i]!, sv[2 * i + 1]!];
}

/** Amplitude of a basis state given by its bitstring, qubit 0 leftmost. */
export function ampOf(sv: Float64Array, bits: string): [number, number] {
  return amp(sv, parseInt(bits, 2));
}

export function expectAmp(sv: Float64Array, bits: string, re: number, im = 0, tol = 1e-9): void {
  const [r, i] = ampOf(sv, bits);
  expect(Math.abs(r - re), `Re|${bits}> expected ${re}, got ${r}`).toBeLessThan(tol);
  expect(Math.abs(i - im), `Im|${bits}> expected ${im}, got ${i}`).toBeLessThan(tol);
}

export function probOf(c: Circuit, bits: string): number {
  const r = simulate(c);
  return r.probabilities[parseInt(bits, 2)]!;
}

/** Total variation distance between two count dictionaries. */
export function tvd(a: Record<string, number>, b: Record<string, number>): number {
  const na = Object.values(a).reduce((x, y) => x + y, 0);
  const nb = Object.values(b).reduce((x, y) => x + y, 0);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let d = 0;
  for (const k of keys) d += Math.abs((a[k] ?? 0) / na - (b[k] ?? 0) / nb);
  return d / 2;
}

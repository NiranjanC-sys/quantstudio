/**
 * Complex linear algebra on flat Float64Arrays, interleaved [re, im, re, im, ...].
 *
 * Flat typed arrays rather than {re, im} objects: a 20-qubit statevector is
 * 1,048,576 amplitudes and object allocation at that scale is what makes naive
 * browser simulators unusable.
 */

/** A dense complex matrix, row-major, interleaved re/im. */
export interface CMatrix {
  /** Side length. Matrices here are always square. */
  n: number;
  /** Length 2 * n * n. */
  d: Float64Array;
}

export function cmat(n: number, values?: readonly number[]): CMatrix {
  const d = new Float64Array(2 * n * n);
  if (values) {
    if (values.length !== d.length) {
      throw new Error(`cmat: expected ${d.length} values for n=${n}, got ${values.length}`);
    }
    d.set(values);
  }
  return { n, d };
}

export function identity(n: number): CMatrix {
  const m = cmat(n);
  for (let i = 0; i < n; i++) m.d[2 * (i * n + i)] = 1;
  return m;
}

export function get(m: CMatrix, r: number, c: number): [number, number] {
  const k = 2 * (r * m.n + c);
  return [m.d[k]!, m.d[k + 1]!];
}

export function set(m: CMatrix, r: number, c: number, re: number, im: number): void {
  const k = 2 * (r * m.n + c);
  m.d[k] = re;
  m.d[k + 1] = im;
}

export function multiply(a: CMatrix, b: CMatrix): CMatrix {
  if (a.n !== b.n) throw new Error('multiply: dimension mismatch');
  const n = a.n;
  const out = cmat(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const ka = 2 * (i * n + k);
      const ar = a.d[ka]!;
      const ai = a.d[ka + 1]!;
      if (ar === 0 && ai === 0) continue;
      for (let j = 0; j < n; j++) {
        const kb = 2 * (k * n + j);
        const br = b.d[kb]!;
        const bi = b.d[kb + 1]!;
        const ko = 2 * (i * n + j);
        out.d[ko] = out.d[ko]! + ar * br - ai * bi;
        out.d[ko + 1] = out.d[ko + 1]! + ar * bi + ai * br;
      }
    }
  }
  return out;
}

export function dagger(a: CMatrix): CMatrix {
  const n = a.n;
  const out = cmat(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const [re, im] = get(a, j, i);
      set(out, i, j, re, -im);
    }
  }
  return out;
}

export function kron(a: CMatrix, b: CMatrix): CMatrix {
  const n = a.n * b.n;
  const out = cmat(n);
  for (let i = 0; i < a.n; i++) {
    for (let j = 0; j < a.n; j++) {
      const [ar, ai] = get(a, i, j);
      if (ar === 0 && ai === 0) continue;
      for (let k = 0; k < b.n; k++) {
        for (let l = 0; l < b.n; l++) {
          const [br, bi] = get(b, k, l);
          set(out, i * b.n + k, j * b.n + l, ar * br - ai * bi, ar * bi + ai * br);
        }
      }
    }
  }
  return out;
}

export function isUnitary(a: CMatrix, tol = 1e-10): boolean {
  const p = multiply(dagger(a), a);
  const id = identity(a.n);
  for (let i = 0; i < p.d.length; i++) {
    if (Math.abs(p.d[i]! - id.d[i]!) > tol) return false;
  }
  return true;
}

export function maxAbsDiff(a: CMatrix, b: CMatrix): number {
  if (a.n !== b.n) return Infinity;
  let m = 0;
  for (let i = 0; i < a.d.length; i++) m = Math.max(m, Math.abs(a.d[i]! - b.d[i]!));
  return m;
}

/** True when a and b differ only by a global phase. */
export function equalUpToPhase(a: CMatrix, b: CMatrix, tol = 1e-9): boolean {
  if (a.n !== b.n) return false;
  // Find the largest-magnitude entry of a to fix the phase reference.
  let bi = -1;
  let best = 0;
  for (let i = 0; i < a.d.length; i += 2) {
    const mag = a.d[i]! * a.d[i]! + a.d[i + 1]! * a.d[i + 1]!;
    if (mag > best) {
      best = mag;
      bi = i;
    }
  }
  if (bi < 0 || best < tol) {
    return maxAbsDiff(a, b) <= tol;
  }
  const ar = a.d[bi]!;
  const ai = a.d[bi + 1]!;
  const br = b.d[bi]!;
  const biv = b.d[bi + 1]!;
  const den = br * br + biv * biv;
  if (den < tol) return false;
  // phase = a_ref / b_ref
  const pr = (ar * br + ai * biv) / den;
  const pi = (ai * br - ar * biv) / den;
  if (Math.abs(pr * pr + pi * pi - 1) > 1e-7) return false;
  for (let i = 0; i < a.d.length; i += 2) {
    const xr = b.d[i]! * pr - b.d[i + 1]! * pi;
    const xi = b.d[i]! * pi + b.d[i + 1]! * pr;
    if (Math.abs(xr - a.d[i]!) > tol || Math.abs(xi - a.d[i + 1]!) > tol) return false;
  }
  return true;
}

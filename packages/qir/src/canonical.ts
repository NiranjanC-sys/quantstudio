/**
 * Canonical form and content hashing.
 *
 * Two circuits that are semantically identical must produce the same hash, so
 * that thousands of learners running the same lesson circuit hit one cache
 * entry. Canonicalisation: rewrite controlled aliases to base + sorted
 * controls, sort commuting ops within a layer by a stable key, drop barriers
 * and metadata, and round angles to 1e-12.
 */

import { GATES } from './gates.js';
import { layerize } from './analysis.js';
import { type Circuit, type Op, isSymbolic } from './types.js';

const ANGLE_PRECISION = 1e12;

function roundAngle(x: number): number {
  const twoPi = 2 * Math.PI;
  let a = x % twoPi;
  if (a <= -Math.PI) a += twoPi;
  if (a > Math.PI) a -= twoPi;
  const r = Math.round(a * ANGLE_PRECISION) / ANGLE_PRECISION;
  return Object.is(r, -0) ? 0 : r;
}

/** Rewrite a controlled alias into its base gate plus explicit controls. */
export function normaliseOp(op: Op): Op {
  const def = GATES[op.gate];
  if (!def?.controlledForm) return op;
  const nc = def.controlledForm.controls;
  if (nc < 0) {
    return { ...op, gate: def.controlledForm.base };
  }
  const controls = [...(op.controls ?? []), ...op.targets.slice(0, nc)];
  return {
    ...op,
    gate: def.controlledForm.base,
    controls: controls.slice().sort((a, b) => a - b),
    targets: op.targets.slice(nc),
  };
}

function opKey(op: Op): string {
  const params = (op.params ?? [])
    .map((p) => (isSymbolic(p) ? `@${p.symbol}` : String(roundAngle(p))))
    .join(',');
  const controls = (op.controls ?? []).slice().sort((a, b) => a - b).join('.');
  const cbits = (op.cbits ?? []).join('.');
  const cond = op.condition ? `?${op.condition.bits.join('.')}=${op.condition.value}` : '';
  return `${op.gate}|${controls}|${op.targets.join('.')}|${params}|${cbits}${cond}`;
}

export function canonicalise(circuit: Circuit): Circuit {
  const kept = circuit.ops.filter((o) => o.gate !== 'barrier').map(normaliseOp);
  const withBarriers: Circuit = { ...circuit, ops: kept };
  const layers = layerize(withBarriers);
  const buckets: Op[][] = [];
  kept.forEach((op, i) => {
    const l = layers[i]!;
    (buckets[l] ??= []).push(op);
  });
  const ops: Op[] = [];
  for (const bucket of buckets) {
    if (!bucket) continue;
    bucket.sort((a, b) => opKey(a).localeCompare(opKey(b)));
    ops.push(...bucket);
  }
  return { version: circuit.version, name: circuit.name, qubits: circuit.qubits, clbits: circuit.clbits, ops };
}

/** Stable string used as the cache key. Excludes name and metadata. */
export function canonicalString(circuit: Circuit): string {
  const c = canonicalise(circuit);
  return `q${c.qubits}c${c.clbits};` + c.ops.map(opKey).join(';');
}

/** FNV-1a 64-bit as two 32-bit halves, rendered hex. No crypto dependency. */
export function circuitHash(circuit: Circuit): string {
  const s = canonicalString(circuit);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(c + i, 0x85ebca6b)) >>> 0;
    h2 ^= h2 >>> 13;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** True when two circuits are the same up to commuting reorder and aliasing. */
export function equivalentByStructure(a: Circuit, b: Circuit): boolean {
  return canonicalString(a) === canonicalString(b);
}


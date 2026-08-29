// lib/circuits.js
//
// Circuit-IR payloads for POST /simulate, in the shape the gateway actually
// accepts (apps/api/src/routes/simulate.ts `bodySchema`):
//
//   { circuit: { version: 1, name, qubits, clbits, ops: [{id, gate, targets,
//     controls?, params?}] }, backend, shots, seed, bindings, noise?, includeVisual }
//
// The previous version of this file sent `{qubits, backend:'statevector-wasm',
// gates:[{layer, op, qubits}]}`, which the gateway rejects with a 400 before it
// ever reaches the kernel, and used a two-qubit `cx` with one target, which the
// kernel rejects with 422 ("cx expects 2 target(s), got 1"). Both are fixed here.
//
// TIER MODEL (§4) VERSUS WHAT THE KERNEL ACTUALLY DOES
// ---------------------------------------------------
// §4 claims T-B ("server statevector, 15-30 qubits") runs in 40-900 ms. Measured
// cold, single request, idle machine, this build of the kernel:
//
//   8q 11 ms | 12q 23 ms | 14q 72 ms | 16q 336 ms | 18q 1,037 ms
//   20q 1,929 ms | 22q 5,666 ms | 24q 20,706 ms
//
// The gateway aborts the upstream call at QUANTUM_KERNEL_TIMEOUT_MS * 4 =
// 3,600 ms, so anything above ~20 qubits returns 503 on a cache miss no matter
// how lightly loaded the box is. That is measured, not modelled — see
// docs/architecture/load-test-report.md.
//
// Consequently there are two qubit distributions here, and the run says which
// one it used:
//
//   SIM_MIX=spec      — uniform over §4's stated T-B band (15-30 qubits).
//                       Reproduces what §4 says the server tier handles.
//   SIM_MIX=feasible  — the sub-band that fits inside the gateway's own
//                       timeout (8-18 qubits). Used for the mixed workload so
//                       that the other four cohorts can be measured instead of
//                       being buried behind kernel timeouts.
//
// Nothing here is tuned for a nicer number: `spec` is run and reported too, and
// its failure rate is the point.

/** Deterministic PRNG so a (qubits, seed) pair always yields identical IR. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONE_QUBIT = ['h', 'x', 'y', 'z', 's', 't', 'rz', 'rx', 'ry'];
const SEED_BASE = 424242;
const DEPTH = 3;

/**
 * Hadamard wall, then alternating brick-wall CX layers and rotation layers.
 * Gates within a layer are emitted in ascending target order, matching §4's
 * canonicalisation ("sorts commuting gates within a layer"), so identical
 * circuits hash identically and hit the Redis `sim:{hash}` cache on purpose.
 */
export function buildCircuit(qubits, seed) {
  const rand = mulberry32(seed);
  const ops = [];
  let k = 0;
  for (let q = 0; q < qubits; q++) ops.push({ id: `h${k++}`, gate: 'h', targets: [q] });
  for (let d = 0; d < DEPTH; d++) {
    for (let q = d % 2; q + 1 < qubits; q += 2) {
      ops.push({ id: `c${k++}`, gate: 'cx', targets: [q, q + 1] });
    }
    for (let q = 0; q < qubits; q++) {
      const gate = ONE_QUBIT[Math.floor(rand() * ONE_QUBIT.length)];
      const op = { id: `g${k++}`, gate, targets: [q] };
      if (gate[0] === 'r') op.params = [Number((rand() * Math.PI * 2).toFixed(6))];
      ops.push(op);
    }
  }
  return { version: 1, name: `lt-${qubits}`, qubits, clbits: 0, ops };
}

export function tierFor(qubits) {
  if (qubits <= 14) return 'T-A';
  if (qubits <= 30) return 'T-B';
  return 'T-C';
}

const SPEC_QUBITS = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
const FEASIBLE_QUBITS = [8, 10, 12, 14, 16, 18];

/** Pre-built payload bodies, one per qubit count, built once in init context. */
const CACHE = {};
function payloadFor(qubits) {
  if (!CACHE[qubits]) {
    CACHE[qubits] = {
      circuit: buildCircuit(qubits, SEED_BASE + qubits),
      backend: 'native',
      shots: 1024,
      seed: SEED_BASE + qubits,
      bindings: {},
      includeVisual: false,
    };
  }
  return CACHE[qubits];
}

export const SIM_MIX = __ENV.SIM_MIX || 'feasible';

/**
 * Weighted pick over the active mix.
 *
 * `feasible` weights toward the small end, which is what a product whose client
 * engine owns everything <= 14 qubits (§4 T-A) would actually push to the
 * server: mostly "just above the client ceiling" circuits.
 */
export function pickQubits(rand = Math.random) {
  if (SIM_MIX === 'spec') {
    return SPEC_QUBITS[Math.floor(rand() * SPEC_QUBITS.length)];
  }
  const r = rand();
  if (r < 0.15) return 8;
  if (r < 0.3) return 10;
  if (r < 0.5) return 12;
  if (r < 0.75) return 14;
  if (r < 0.92) return 16;
  return 18;
}

export function simBody(qubits) {
  return payloadFor(qubits);
}

/**
 * A cache-missing variant: §4's cache key includes the seed, so bumping the
 * seed forces a cold run. Used by sim-capacity.js to separate "the kernel is
 * fast" from "Redis remembered the answer".
 */
export function simBodyCold(qubits, nonce) {
  return {
    circuit: buildCircuit(qubits, SEED_BASE + qubits),
    backend: 'native',
    shots: 1024,
    seed: (SEED_BASE + nonce) % 2147483647,
    bindings: {},
    includeVisual: false,
  };
}

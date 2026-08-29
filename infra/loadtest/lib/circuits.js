// lib/circuits.js
//
// A small, deterministic library of circuit-IR payloads used to exercise the
// three simulation tiers from system-design.md §4:
//
//   T-A  client statevector   <= 14 qubits   ~92% of "editing circuit" sims
//   T-B  server statevector   15-30 qubits   ~7.5%
//   T-C  heavy / async queue  31-40 qubits   ~0.5% (or noisy density-matrix)
//
// We ship five qubit counts chosen to sit exactly on or straddle those
// boundaries and the §7 per-plan qubit ceilings, so a mixed-qubit workload
// naturally crosses every tier transition instead of clustering in one:
//
//   8   - comfortably T-A. Also the Free-plan "typical" circuit size.
//   14  - the T-A/T-B boundary itself (T-A is defined as "<= 14 qubits").
//   22  - mid T-B. Above Free's 16-qubit ceiling -> exercises entitlement
//         checks for Free-plan synthetic users; within Pro/Teams/Campus.
//   28  - top of T-B, and exactly the Pro-plan ceiling (§7) - the circuit a
//         Pro user is allowed to run but a Teams/Campus user still isn't
//         capped by.
//   32  - T-C territory (31-40) and the Campus-plan ceiling (§7), i.e. the
//         single largest circuit anyone on the platform can legally submit.
//         2^32 * 16 bytes = 64 GiB statevector - this is exactly why T-C
//         lives on the memory-optimised quantum-kernel-heavy pool (96-120Gi
//         request/limit per infra SPEC.md), not the general kernel fleet.
//
// Canonicalisation (§4): "sorts commuting gates within a layer, so
// semantically identical circuits collide [cache-key-wise] intentionally."
// We reproduce that ordering here (gates within a layer sorted by target
// qubit index) so that repeated calls with the same seed are guaranteed to
// hit the Redis sim cache (`sim:{hash}`) - which is itself something this
// suite measures (see `sim_cache_hit_rate` in main.js).
//
// Determinism matters beyond caching: contest-burst.js needs every VU to be
// able to independently regenerate "what should have happened" without
// sharing memory across VUs (k6 VUs do not share JS heap state), so every
// generator here is a pure function of (qubits, seed).

/** Mulberry32 PRNG - tiny, deterministic, seeded. Good enough for synthetic
 * gate placement; this is a load generator, not a physics engine. */
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

const ONE_QUBIT_GATES = ['h', 'x', 'y', 'z', 's', 't', 'rz', 'rx', 'ry'];

/**
 * Build a deterministic, layered circuit: an initial Hadamard wall (to make
 * every simulation touch the full 2^n amplitude space instead of trivially
 * collapsing), followed by `depth` layers alternating single-qubit rotations
 * and a brick-wall of two-qubit CX gates, all seeded off `seed` so the same
 * (qubits, seed) pair always yields byte-identical IR.
 *
 * @param {number} qubits
 * @param {number} seed
 * @returns {{ qubits: number, gates: Array<object>, depth: number }}
 */
export function generateCircuit(qubits, seed) {
  const rand = mulberry32(seed);
  const depth = Math.max(4, Math.round(Math.log2(qubits + 1) * 6));
  const gates = [];

  // Layer 0: Hadamard wall, canonical order = ascending qubit index.
  for (let q = 0; q < qubits; q++) {
    gates.push({ layer: 0, op: 'h', qubits: [q] });
  }

  for (let layer = 1; layer <= depth; layer++) {
    const layerGates = [];
    if (layer % 2 === 1) {
      // Odd layers: brick-wall CX, offset alternates so entanglement spreads.
      const offset = ((layer - 1) / 2) % 2;
      for (let q = offset; q + 1 < qubits; q += 2) {
        layerGates.push({ layer, op: 'cx', qubits: [q, q + 1] });
      }
    } else {
      // Even layers: single-qubit rotations, angle seeded per gate.
      for (let q = 0; q < qubits; q++) {
        const op = ONE_QUBIT_GATES[Math.floor(rand() * ONE_QUBIT_GATES.length)];
        const params = op.startsWith('r') ? [Number((rand() * Math.PI * 2).toFixed(6))] : [];
        layerGates.push({ layer, op, qubits: [q], params });
      }
    }
    // Canonicalisation: sort commuting gates within a layer by qubit index.
    layerGates.sort((a, b) => a.qubits[0] - b.qubits[0]);
    gates.push(...layerGates);
  }

  return { qubits, gates, depth };
}

/**
 * @param {number} qubits
 * @returns {'T-A'|'T-B'|'T-C'}
 */
export function tierFor(qubits) {
  if (qubits <= 14) return 'T-A';
  if (qubits <= 30) return 'T-B';
  return 'T-C';
}

const SEED_BASE = 424242;

/**
 * The five boundary payloads, pre-built once at module load (VU init
 * context) so every VU/iteration reuses identical, cache-friendly IR instead
 * of paying generation cost per iteration.
 */
export const CIRCUITS = {
  8: buildPayload(8),
  14: buildPayload(14),
  22: buildPayload(22),
  28: buildPayload(28),
  32: buildPayload(32),
};

function buildPayload(qubits) {
  const circuit = generateCircuit(qubits, SEED_BASE + qubits);
  return {
    qubits,
    tier: tierFor(qubits),
    seed: SEED_BASE + qubits,
    backend: qubits <= 14 ? 'statevector-wasm' : 'statevector',
    shots: 1024,
    noise_model: null,
    circuit,
  };
}

/**
 * §4 cache key: sha256(canonical_ir || backend || shots || noise_model || seed).
 * We don't need to *compute* sha256 client-side (the server owns that), but
 * we do need a stable request body so repeated calls are byte-identical -
 * which `CIRCUITS` above already guarantees since it's built once.
 *
 * @param {8|14|22|28|32} qubits
 * @returns {object}
 */
export function circuitRequestBody(qubits) {
  const c = CIRCUITS[qubits];
  if (!c) throw new Error(`no canned circuit for ${qubits} qubits`);
  return {
    qubits: c.qubits,
    backend: c.backend,
    shots: c.shots,
    noise_model: c.noise_model,
    seed: c.seed,
    gates: c.circuit.gates,
  };
}

/**
 * Weighted picker for the "editing circuits" scenario. Weights approximate:
 * most server-visible edits are mid-size T-B circuits (the ones too big for
 * the client WASM engine to keep at frame rate but still "just editing"),
 * a meaningful top-of-T-B slice, a rare T-C circuit, and a thin sliver of
 * circuits that are nominally T-A size but still hit the server (e.g. a
 * low-power/mobile client that disables the local WASM engine, or an
 * explicit "verify on server" action) - see main.js for how this composes
 * with CLIENT_SIM_SHARE.
 *
 * @param {() => number} rand - a [0,1) RNG, e.g. Math.random
 * @returns {8|14|22|28|32}
 */
export function pickServerCircuitQubits(rand = Math.random) {
  const r = rand();
  if (r < 0.05) return 8;
  if (r < 0.15) return 14;
  if (r < 0.65) return 22;
  if (r < 0.9) return 28;
  return 32;
}

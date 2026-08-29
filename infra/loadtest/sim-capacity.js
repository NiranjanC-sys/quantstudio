// sim-capacity.js — how many server-side simulations per second does this
// deployment of the quantum kernel actually sustain, and at what latency?
//
// §1 sizes the simulation tier at "24 pods, 6 workers/pod, 3 sim/s/worker" =
// 432 sim/s of capacity for a claimed 110 sim/s steady / 400 sim/s peak.
// §4 claims T-B (15-30 qubits) runs in 40-900 ms.
//
// This script measures the two numbers that claim rests on, against whatever is
// actually listening on QUANTUM_KERNEL_URL:
//
//   MODE=sweep       one request per qubit count, cold (unique seed per run so
//                    §4's `sim:{hash}` cache cannot answer it), to get the
//                    latency-vs-qubits curve.
//   MODE=throughput  constant-arrival-rate at RATE sim/s of a fixed qubit size,
//                    to find the rate at which the kernel stops keeping up.
//
// TARGET=gateway (default) goes through POST /simulate, which is what a user
// experiences: session resolution, entitlement check, credit debit, the
// 3,600 ms upstream abort, and the credit refund on failure.
// TARGET=kernel goes straight to POST /v1/simulate with an X-RedQuant-Plan
// header, isolating the numerics from everything the gateway adds.
//
// CACHE=cold (default) bumps the seed per iteration so every request is a cache
// miss. CACHE=warm reuses one payload, which measures the Redis/in-process
// cache path instead — both are reported, because §4 leans on a "high" hit rate
// and the two numbers are an order of magnitude apart.

import http from 'k6/http';
import exec from 'k6/execution';
import { Trend, Rate, Counter } from 'k6/metrics';
import { BASE_URL, KERNEL_URL } from './lib/config.js';
import { authHeaders, userForIteration } from './lib/fixtures.js';
import { buildCircuit, simBody, simBodyCold } from './lib/circuits.js';

const MODE = __ENV.SIM_MODE || 'throughput';
const TARGET = __ENV.TARGET || 'gateway';
const CACHE = __ENV.CACHE || 'cold';
const QUBITS = Number(__ENV.QUBITS || '14');
const RATE = Number(__ENV.RATE || '10');
const DURATION = __ENV.DURATION || '60s';
const SWEEP = (__ENV.SWEEP || '8,10,12,14,16,18,20,22').split(',').map(Number);

const lat = new Trend('sim_latency', true);
const ok = new Rate('sim_ok');
const timeout503 = new Counter('sim_503_upstream');
const kernel504 = new Counter('sim_kernel_error');
const byQubits = {};
for (const q of SWEEP) byQubits[q] = new Trend(`sim_q${q}`, true);

export const options = MODE === 'sweep'
  ? {
      scenarios: { sweep: { executor: 'per-vu-iterations', vus: 1, iterations: SWEEP.length, exec: 'sweep', maxDuration: '10m' } },
      summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'avg'],
    }
  : {
      scenarios: {
        throughput: {
          executor: 'constant-arrival-rate',
          exec: 'throughput',
          rate: RATE,
          timeUnit: '1s',
          duration: DURATION,
          preAllocatedVUs: Math.max(50, RATE * 6),
          maxVUs: Math.max(100, RATE * 20),
          gracefulStop: '30s',
        },
      },
      summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'avg'],
    };

http.setResponseCallback(http.expectedStatuses(200, 201, 202, 403, 429));

function send(qubits, nonce) {
  const body = CACHE === 'warm' ? simBody(qubits) : simBodyCold(qubits, nonce);
  if (TARGET === 'kernel') {
    // The kernel's own contract: circuit + options, plan in a header (§3 — the
    // kernel does no auth and no billing).
    const payload = {
      circuit: body.circuit,
      backend: 'native',
      include_visual: false,
      options: {
        shots: body.shots,
        seed: body.seed,
        bindings: {},
        method: 'statevector',
        max_qubits: 32,
        return_statevector: qubits <= 18,
        ...(qubits > 16 ? { probability_top_k: 64 } : {}),
      },
    };
    return http.post(`${KERNEL_URL}/v1/simulate`, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json', 'X-RedQuant-Plan': 'campus' },
      tags: { name: 'POST /v1/simulate', qubits: String(qubits) },
      timeout: '120s',
    });
  }
  // Gateway path. Campus-plan accounts, so the §7 ceiling (32 qubits) never
  // masks a kernel result with a 403.
  const user = userForIteration('editing', nonce);
  return http.post(`${BASE_URL}/simulate`, JSON.stringify(body), {
    headers: authHeaders(user, exec.vu.idInTest, { 'Content-Type': 'application/json' }),
    tags: { name: 'POST /simulate', qubits: String(qubits) },
    timeout: '120s',
  });
}

export function sweep() {
  const q = SWEEP[exec.scenario.iterationInTest % SWEEP.length];
  const res = send(q, 1000000 + Date.now() % 1000000 + q);
  lat.add(res.timings.duration, { qubits: String(q) });
  byQubits[q].add(res.timings.duration);
  ok.add(res.status === 200);
  if (res.status === 503) timeout503.add(1);
  console.log(`qubits=${q} status=${res.status} ms=${Math.round(res.timings.duration)} bytes=${res.body ? res.body.length : 0} cached=${String(res.body).indexOf('"cached":true') >= 0}`);
}

export function throughput() {
  const n = exec.scenario.iterationInTest;
  const res = send(QUBITS, n);
  lat.add(res.timings.duration);
  ok.add(res.status === 200);
  if (res.status === 503) timeout503.add(1);
  if (res.status >= 500 && res.status !== 503) kernel504.add(1);
}

export function handleSummary(data) {
  const label = __ENV.RUN_LABEL || `sim-${MODE}-${TARGET}-${CACHE}-q${QUBITS}-r${RATE}`;
  return {
    stdout: textSummary(data),
    [`results/${label}-summary.json`]: JSON.stringify(data, null, 2),
  };
}
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
void buildCircuit;

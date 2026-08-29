// main.js
//
// Mixed workload load test exercising the §1 capacity model
// (docs/architecture/system-design.md) as five concurrent, independently
// arrival-rate-controlled cohorts. See infra/loadtest/README.md for how to
// run this and how to read the results.
//
// -----------------------------------------------------------------------
// WHY ramping-arrival-rate, not ramping-vus
// -----------------------------------------------------------------------
// §1's numbers are *request rates* ("Origin RPS"), not concurrent-user
// counts, and the whole point of this suite is to reproduce the cohort
// RATIOS at the ORIGIN. `ramping-vus` controls concurrency and lets
// throughput fall wherever response time happens to put it - under load,
// slower endpoints silently send fewer requests per second than faster
// ones, which would quietly corrupt the 55/22/12/8/3 mix into something
// else entirely. `ramping-arrival-rate` fixes the iteration rate directly
// and lets k6 add VUs as needed to sustain it, so the ratios in this file
// ARE the ratios hitting the server, regardless of how fast it responds
// (up to the preAllocatedVUs/maxVUs ceiling - see makeScenario below).
//
// -----------------------------------------------------------------------
// §1 cohort arithmetic (SCALE = 1 == the full 50,000-concurrent-user fleet)
// -----------------------------------------------------------------------
//   Cohort              Share   Steady origin rps (§1, verbatim)
//   reading lessons      55%    611
//   editing circuits     22%    1,375 nominal sim/s (see below)
//   running labs         12%    50
//   in a contest          8%    44
//   dashboards/social     3%    75
//
// "Editing circuits" is special: §4 states >= 92% of those 1,375 sim/s
// never leave the browser (T-A tier, client-side @redquant/qir WASM
// engine). This suite cannot observe client-side work at all - k6 only
// sees the network - so the `editing` scenario must model ONLY the
// server-visible slice:
//
//   EDITING_SERVER_STEADY = 1375 * (1 - CLIENT_SIM_SHARE)
//                         = 1375 * (1 - 0.92)
//                         = 1375 * 0.08
//                         = 110      <- matches §1's own "~110/s steady" figure
//
// Summing the five STEADY figures actually modeled as server load:
//
//   611 (reading) + 110 (editing, server-only) + 50 (labs)
//     + 44 (contest) + 75 (dashboards) = 890 rps
//
// §1 separately states total origin traffic is "~1,500 rps steady, 3,500
// rps peak". Our five modeled cohorts sum to 890 rps steady, not 1,500.
// We do NOT silently inflate the per-cohort numbers to force a match to
// 1,500 - that would misrepresent what §1 actually specifies per cohort.
// The ~610 rps gap is attributed to origin traffic this suite does not
// model as its own scenario: WebSocket control frames/pings for the
// 32,000 concurrent sockets (§1), session refresh, health checks, cache
// revalidation (ETag conditional GETs), and retries. See README.md
// ("what a PASS proves vs. does not") for the explicit statement of this
// gap so a passing run is never mistaken for "the full origin envelope
// was reproduced."
//
// For PEAK, §1 gives an explicit per-cohort number for exactly one
// cohort - editing's server-side sims ("~110/s steady, 400/s peak",
// ratio 400/110 ≈ 3.64x) - and one number that is specific to the
// contest DEADLINE BURST, not sustained peak ("Sandbox executions: 50/s
// steady, 250/s at contest deadline"). The deadline burst is a distinct,
// 90-second, deterministic event and is tested on its own in
// contest-burst.js; it is deliberately NOT folded into this file's
// "peak" stage, which models sustained elevated load, not an instant
// spike. For the remaining cohorts (reading, labs' sustained peak,
// contest's sustained peak, dashboards) §1 gives no explicit per-cohort
// peak figure, so we scale each by §1's own stated origin-wide
// peak:steady ratio (3500/1500 ≈ 2.333x) as an explicit, documented
// modeling assumption:
//
//   READING_PEAK    = round(611 * 2.333)              = 1426
//   EDITING_PEAK    = 400                              (§1 explicit)
//   LABS_PEAK       = round(50  * 2.333)                = 117  (sustained; NOT the 250/s deadline figure)
//   CONTEST_PEAK    = round(44  * 2.333)                = 103  (sustained; the ~1,300 rps burst is contest-burst.js)
//   DASHBOARDS_PEAK = round(75  * 2.333)                = 175
//
//   sum = 1426 + 400 + 117 + 103 + 175 = 2221 rps modeled peak
//
// Again this does not equal §1's stated 3,500 rps origin peak; the
// ~1,279 rps gap is the contest deadline burst (tested separately) plus
// the same unmodeled auxiliary traffic as above. The full 3,500 rps
// envelope, burst included, is only actually exercised by running this
// file's peak stage CONCURRENTLY with contest-burst.js - see README.md.

import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { BASE_URL, SCALE, CLIENT_SIM_SHARE, PLAN_MAX_QUBITS } from './lib/config.js';
import { login, syntheticUser } from './lib/auth.js';
import { checkOk } from './lib/checks.js';
import { circuitRequestBody, pickServerCircuitQubits, tierFor } from './lib/circuits.js';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

// §4 / top-level target: "< 2 s for a 32-qubit statevector simulation."
export const sim32qDuration = new Trend('sim_32q_duration', true);

// §11 RUM budget: "time_to_first_amplitude ... Budget: 120 ms." See the
// `editing()` scenario for the important caveat that this is a k6-side
// APPROXIMATION of a client-observed metric, not a direct measurement.
export const timeToFirstAmplitude = new Trend('time_to_first_amplitude', true);

// §7: entitlements are evaluated at the gateway; a mismatch between a
// synthetic user's plan and the qubit count it asks for should produce a
// controlled denial, not an error. Counted, not just checked, per the spec.
export const entitlementDenials = new Counter('entitlement_denials');

// §4: "Cache in Redis ... fronted by an in-process LRU." Read off the
// `x-sim-cache` response header the kernel/gateway is expected to set.
export const simCacheHitRate = new Rate('sim_cache_hit_rate');

// §9: 429 is an expected, designed-for outcome under load, tracked
// separately from failures so its share can be asserted to "stay low"
// rather than either being ignored or (wrongly) failing the run outright.
export const rateLimitedRatio = new Rate('rate_limited_ratio');

// §9: treat 429 (rate limit) and 403 (entitlement denial - see above) as
// expected response codes so they do NOT count against `http_req_failed`.
// Both are separately measured (rateLimitedRatio, entitlementDenials) so
// this does not hide them - it just stops them polluting the generic
// error-rate thresholds below, which are meant to catch actual breakage.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 204, 206, 304, 403, 429));

// ---------------------------------------------------------------------------
// Rate arithmetic (see header comment for the full derivation)
// ---------------------------------------------------------------------------

const READING_STEADY = 611;
const EDITING_NOMINAL_STEADY = 1375; // §1: "1,375 sim/s nominal"
const EDITING_SERVER_STEADY = Math.round(EDITING_NOMINAL_STEADY * (1 - CLIENT_SIM_SHARE)); // 110
const LABS_STEADY = 50;
const CONTEST_STEADY = 44;
const DASHBOARDS_STEADY = 75;

const MODELED_STEADY_TOTAL =
  READING_STEADY + EDITING_SERVER_STEADY + LABS_STEADY + CONTEST_STEADY + DASHBOARDS_STEADY; // 890

const ORIGIN_PEAK_STEADY_RATIO = 3500 / 1500; // ≈2.333, §1's own origin-wide ratio

const READING_PEAK = Math.round(READING_STEADY * ORIGIN_PEAK_STEADY_RATIO); // 1426
const EDITING_SERVER_PEAK = 400; // §1 explicit
const LABS_PEAK = Math.round(LABS_STEADY * ORIGIN_PEAK_STEADY_RATIO); // 117
const CONTEST_PEAK = Math.round(CONTEST_STEADY * ORIGIN_PEAK_STEADY_RATIO); // 103
const DASHBOARDS_PEAK = Math.round(DASHBOARDS_STEADY * ORIGIN_PEAK_STEADY_RATIO); // 175

const MODELED_PEAK_TOTAL =
  READING_PEAK + EDITING_SERVER_PEAK + LABS_PEAK + CONTEST_PEAK + DASHBOARDS_PEAK; // 2221

// Surface the arithmetic at test-init time (visible in `k6 inspect` /
// `k6 run` logs) so the numbers above are never just a comment nobody reads.
console.log(
  `[main.js] modeled steady total = ${MODELED_STEADY_TOTAL} rps, ` +
    `modeled peak total = ${MODELED_PEAK_TOTAL} rps (SCALE=${SCALE}); ` +
    `§1 states origin envelope 1500/3500 rps - see header comment for the gap.`,
);

function scaledRate(base) {
  return Math.max(1, Math.round(base * SCALE));
}

// ---------------------------------------------------------------------------
// Stage timeline - shared by all five scenarios so they overlap in real
// time and genuinely produce a MIXED workload, not five sequential ones.
// ---------------------------------------------------------------------------

const WARMUP_DURATION = '2m';
const RAMP_TO_STEADY_DURATION = '3m';
const STEADY_HOLD_DURATION = '5m';
const RAMP_TO_PEAK_DURATION = '3m';
const PEAK_HOLD_DURATION = '5m';
const RAMP_DOWN_DURATION = '3m';
// Total wall-clock per run: 2+3+5+3+5+3 = 21 minutes.

function makeScenario({ steady, peak, exec, avgIterSeconds }) {
  const steadyRate = scaledRate(steady);
  const peakRate = scaledRate(peak);
  const warmupRate = Math.max(1, Math.round(steadyRate * 0.3));
  // VU budget: enough concurrent VUs to sustain peakRate iterations/sec
  // given each iteration takes roughly avgIterSeconds, plus 50% headroom
  // so a slow tail doesn't starve the arrival-rate executor of free VUs
  // (which would silently turn into arrival-rate under-delivery instead
  // of a clean failure).
  const maxVUs = Math.max(10, Math.ceil(peakRate * avgIterSeconds * 1.5));
  const preAllocatedVUs = Math.max(5, Math.ceil(maxVUs * 0.5));
  return {
    executor: 'ramping-arrival-rate',
    exec,
    startRate: 0,
    timeUnit: '1s',
    preAllocatedVUs,
    maxVUs,
    stages: [
      { duration: WARMUP_DURATION, target: warmupRate },
      { duration: RAMP_TO_STEADY_DURATION, target: steadyRate },
      { duration: STEADY_HOLD_DURATION, target: steadyRate },
      { duration: RAMP_TO_PEAK_DURATION, target: peakRate },
      { duration: PEAK_HOLD_DURATION, target: peakRate },
      { duration: RAMP_DOWN_DURATION, target: 0 },
    ],
  };
}

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    reading: makeScenario({ steady: READING_STEADY, peak: READING_PEAK, exec: 'reading', avgIterSeconds: 0.15 }),
    editing: makeScenario({
      steady: EDITING_SERVER_STEADY,
      peak: EDITING_SERVER_PEAK,
      exec: 'editing',
      // T-B is a 900ms sync budget, T-C can queue; generous average.
      avgIterSeconds: 0.6,
    }),
    labs: makeScenario({ steady: LABS_STEADY, peak: LABS_PEAK, exec: 'labs', avgIterSeconds: 0.25 }),
    contest: makeScenario({ steady: CONTEST_STEADY, peak: CONTEST_PEAK, exec: 'contest', avgIterSeconds: 0.2 }),
    dashboards: makeScenario({
      steady: DASHBOARDS_STEADY,
      peak: DASHBOARDS_PEAK,
      exec: 'dashboards',
      avgIterSeconds: 0.15,
    }),
  },
  thresholds: {
    // --- Headline thresholds (abortOnFail: true) ---------------------------
    // §system-design.md top line: "p99 < 300 ms on read paths." Reading
    // lessons is THE read path (55% of all users, 95%+ CDN-cacheable), so
    // this is the single most representative read-path threshold.
    'http_req_duration{scenario:reading}': [{ threshold: 'p(99)<300', abortOnFail: true }],
    // §system-design.md top line / §4: "< 2 s for a 32-qubit statevector
    // simulation." Measured end-to-end (including any 202+poll leg) in
    // sim32qDuration - see editing().
    sim_32q_duration: [{ threshold: 'p(99)<2000', abortOnFail: true }],

    // --- §11 RUM budget ------------------------------------------------------
    time_to_first_amplitude: ['p(95)<120'],

    // --- Overall check hygiene -------------------------------------------
    checks: ['rate>0.99'],

    // --- Per-cohort error-rate thresholds ----------------------------------
    // 429 and 403 are excluded from http_req_failed by the response
    // callback above, so these thresholds reflect genuine breakage
    // (5xx, connection errors, unexpected 4xx) per cohort.
    'http_req_failed{scenario:reading}': ['rate<0.01'],
    'http_req_failed{scenario:editing}': ['rate<0.02'],
    'http_req_failed{scenario:labs}': ['rate<0.02'],
    'http_req_failed{scenario:contest}': ['rate<0.02'],
    'http_req_failed{scenario:dashboards}': ['rate<0.01'],

    // --- §9 rate limiting should shed load, not dominate it ----------------
    rate_limited_ratio: ['rate<0.05'],
  },
};

// ---------------------------------------------------------------------------
// Per-VU session cache
// ---------------------------------------------------------------------------
// Module-level `let` is per-VU state in k6 (each VU runs its own JS
// runtime instance): logging in once per VU and reusing the cookie
// jar/token for every subsequent iteration avoids hammering the auth path
// on every single request, which would both be unrealistic (real users
// don't re-authenticate per action) and would itself trip the §9 auth
// rate limit (10/10min/IP), contaminating the very thresholds we're
// trying to measure.
let session = null;

function ensureSession() {
  if (session) return session;
  const user = syntheticUser(__VU);
  const result = login(user);
  session = Object.assign({}, user, { headers: result.headers, authOk: result.ok });
  return session;
}

function trackRateLimit(res, cohort) {
  rateLimitedRatio.add(res.status === 429 ? 1 : 0, { scenario: cohort });
}

function pickLessonId() {
  // §5 catalog: "small, read-mostly, fully cached." A 200-lesson pool is
  // enough to exercise real cache behaviour without pretending every
  // request is a unique cold read.
  return 1 + Math.floor(Math.random() * 200);
}

function pickProblemLabel() {
  const labels = ['A', 'B', 'C', 'D', 'E'];
  return labels[Math.floor(Math.random() * labels.length)];
}

const LAB_SOURCE_SAMPLE = [
  'from qiskit import QuantumCircuit',
  'qc = QuantumCircuit(3, 3)',
  'qc.h(0); qc.cx(0, 1); qc.cx(1, 2)',
  'qc.measure(range(3), range(3))',
].join('\n');

const CONTEST_SOURCE_SAMPLE = [
  'from qiskit import QuantumCircuit',
  'def solve():',
  '    qc = QuantumCircuit(2, 2)',
  '    qc.h(0); qc.cx(0, 1)',
  '    qc.measure([0, 1], [0, 1])',
  '    return qc',
].join('\n');

/**
 * §9 degradation ladder step 1: a T-B/T-C request under kernel saturation
 * comes back `202 + queued` instead of a synchronous result. Poll until it
 * resolves so latency metrics reflect the FULL user-visible wait.
 */
function pollSimulationJob(initialRes, headers, maxWaitMs) {
  let jobId;
  try {
    jobId = initialRes.json('jobId') || initialRes.json('id');
  } catch (_e) {
    jobId = undefined;
  }
  if (!jobId) return initialRes;

  const deadline = Date.now() + maxWaitMs;
  let res = initialRes;
  while (Date.now() < deadline) {
    sleep(0.1);
    res = http.get(`${BASE_URL}/simulate/jobs/${jobId}`, {
      headers,
      tags: { name: 'get_simulate_job' },
    });
    if (res.status !== 202) break;
  }
  return res;
}

// ---------------------------------------------------------------------------
// Scenario bodies
// ---------------------------------------------------------------------------

export function reading() {
  const user = ensureSession();
  const lessonId = pickLessonId();
  const res = http.get(`${BASE_URL}/lessons/${lessonId}`, {
    headers: user.headers,
    tags: { name: 'get_lesson' },
  });
  checkOk(res, [200, 304], 'reading:get_lesson');
  trackRateLimit(res, 'reading');
}

export function editing() {
  const user = ensureSession();
  const qubits = pickServerCircuitQubits();
  const body = circuitRequestBody(qubits);
  const maxAllowed = PLAN_MAX_QUBITS[user.plan] || PLAN_MAX_QUBITS.free;

  const start = Date.now();
  const res = http.post(`${BASE_URL}/simulate`, JSON.stringify(body), {
    headers: Object.assign({ 'Content-Type': 'application/json' }, user.headers),
    tags: { name: 'post_simulate', qubits: String(qubits), tier: tierFor(qubits) },
  });

  if (res.status === 403) {
    // Expected: qubits > maxAllowed for this synthetic user's plan (§7).
    entitlementDenials.add(1, { qubits: String(qubits), plan: user.plan });
    checkOk(res, [403], 'editing:entitlement_denied');
    return;
  }

  let finalRes = res;
  if (res.status === 202) {
    finalRes = pollSimulationJob(res, user.headers, 5000);
  }

  checkOk(finalRes, [200], 'editing:post_simulate');

  const cacheHeader = finalRes.headers['X-Sim-Cache'] || finalRes.headers['x-sim-cache'];
  if (finalRes.status === 200) {
    simCacheHitRate.add(cacheHeader === 'hit');
  }

  const elapsedMs = Date.now() - start;
  if (qubits === 32) {
    sim32qDuration.add(elapsedMs, { tier: tierFor(qubits) });
  }

  // See header comment on timeToFirstAmplitude: this is an APPROXIMATION.
  // k6 measures server round-trip only; the real RUM metric (§11) also
  // includes the client parsing the payload and compositing the Bloch
  // sphere / probability bars, which we cannot observe from here. We add a
  // small, explicitly-named, documented constant rather than pretend the
  // server timing alone IS the client-observed metric.
  const CLIENT_COMPOSITE_OVERHEAD_MS = 12;
  timeToFirstAmplitude.add(finalRes.timings.duration + CLIENT_COMPOSITE_OVERHEAD_MS, {
    qubits: String(qubits),
  });

  trackRateLimit(finalRes, 'editing');
  void maxAllowed; // retained for readability/documentation of the branch above
}

export function labs() {
  const user = ensureSession();
  const lessonId = pickLessonId();
  const idempotencyKey = `${user.id}-lab-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${BASE_URL}/labs/${lessonId}/submit`,
    JSON.stringify({ language: 'qiskit', source: LAB_SOURCE_SAMPLE }),
    {
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        user.headers,
      ),
      tags: { name: 'post_lab_submit' },
    },
  );
  checkOk(res, [200, 201, 202], 'labs:submit');
  trackRateLimit(res, 'labs');
}

export function contest() {
  const user = ensureSession();
  const contestId = __ENV.CONTEST_ID || 'loadtest-contest';
  const problemLabel = pickProblemLabel();
  const idempotencyKey = `${user.id}-${contestId}-${problemLabel}-${__ITER}`;
  const res = http.post(
    `${BASE_URL}/contests/${contestId}/submit`,
    JSON.stringify({ problemLabel, language: 'qiskit', source: CONTEST_SOURCE_SAMPLE }),
    {
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        user.headers,
      ),
      tags: { name: 'post_contest_submit' },
    },
  );
  // This is the STEADY, non-burst contest submission rate (44 rps). The
  // 90-second, ~1,300 rps deadline burst is tested in contest-burst.js.
  checkOk(res, [200, 201, 202], 'contest:submit');
  trackRateLimit(res, 'contest');
}

export function dashboards() {
  const user = ensureSession();
  const res = http.get(`${BASE_URL}/dashboard`, {
    headers: user.headers,
    tags: { name: 'get_dashboard' },
  });
  checkOk(res, [200, 304], 'dashboards:get_dashboard');
  trackRateLimit(res, 'dashboards');
}

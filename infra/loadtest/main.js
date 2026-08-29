// main.js — mixed §1 cohort workload against a running RedQuant stack.
//
// WHAT CHANGED FROM THE UNRUN VERSION OF THIS FILE
// ------------------------------------------------
// The previous script had never been executed. Every endpoint it called was
// wrong, so a 100% failure rate was the only possible outcome:
//
//   GET  /lessons/{int}          -> 404. Real: GET /catalog/lessons/{slug}
//   GET  /dashboard              -> 404. Real: GET /progress/overview
//   POST /labs/{lessonId}/submit -> 404. Real: POST /labs/submit {lessonId,...}
//   POST /contests/{id}/submit   -> body used `problemLabel`; the route takes
//                                   `problemId` (a uuid) and requires a
//                                   registration row.
//   POST /auth/dev-session       -> 404; no such endpoint exists. See
//                                   lib/fixtures.js for what replaced it.
//   POST /simulate               -> right path, wrong body (see lib/circuits.js).
//   GET  /simulate/jobs/{id}     -> 404; the gateway has no sync-sim job poller,
//                                   so the "202 + queue position" leg of §9's
//                                   degradation ladder is not implemented and
//                                   cannot be measured. The polling code is gone.
//
// COHORT MIX (§1, unchanged arithmetic)
// -------------------------------------
//   reading      611 rps   55% of users, 1 nav / 45 s
//   editing      110 rps   22% of users; 1,375 nominal sim/s of which §4 says
//                          >=92% never leave the browser -> 1375*0.08 = 110
//   labs          50 rps   12% of users, 1 submit / 120 s
//   contest       44 rps    8% of users, 1 submit / 90 s (steady, not the burst)
//   dashboards    75 rps    3% of users, 1 req / 20 s
//                890 rps   modeled steady origin load
//
// §1 states the origin envelope is "~1,500 rps steady, 3,500 rps peak". The five
// modeled cohorts sum to 890, not 1,500; the gap is traffic this suite does not
// model (WebSocket control frames for 32,000 sockets, session refresh, ETag
// revalidation, health checks, retries). It is not inflated to force a match.
//
// TWO EXECUTION MODES
// -------------------
//   MODE=step (default)  constant-arrival-rate at RATE_MULT x the §1 steady mix,
//                        for DURATION. One run per multiplier builds a clean
//                        saturation table; a single ramping run averages the
//                        good and bad stages together and hides the knee.
//   MODE=ramp            one ramping-arrival-rate run through the whole curve,
//                        for the "does the mix hold together over 20 min" view.
//
// ENV
//   BASE_URL     default http://localhost:3001
//   RATE_MULT    multiplier on the §1 steady rates (MODE=step). 1 = 890 rps.
//   DURATION     hold time for MODE=step, default 90s
//   SIM_MIX      feasible | spec  (see lib/circuits.js)
//   SPREAD_IPS   1 to give each VU its own X-Forwarded-For (see lib/fixtures.js)

import http from 'k6/http';
import exec from 'k6/execution';
import { Trend, Counter, Rate } from 'k6/metrics';
import { BASE_URL } from './lib/config.js';
import { CONTEST, GRADABLE_LESSON_IDS, LESSON_SLUGS, authHeaders, idempotencyKey, userForIteration } from './lib/fixtures.js';
import { pickQubits, simBody, tierFor, SIM_MIX } from './lib/circuits.js';

// ---------------------------------------------------------------- rate model
const STEADY = { reading: 611, editing: 110, labs: 50, contest: 44, dashboards: 75 };
const STEADY_TOTAL = Object.values(STEADY).reduce((a, b) => a + b, 0); // 890
// §1 gives an explicit peak for exactly one cohort (editing: "~110/s steady,
// 400/s peak"). For the rest it gives only the origin-wide 3500/1500 = 2.333x.
const PEAK = { reading: 1426, editing: 400, labs: 117, contest: 103, dashboards: 175 };

const MODE = __ENV.MODE || 'step';
const RATE_MULT = Number(__ENV.RATE_MULT || '1');
const DURATION = __ENV.DURATION || '90s';
const WARMUP = __ENV.WARMUP || '15s';

// ------------------------------------------------------------------ metrics
// One Trend per endpoint class, because http_req_duration aggregated over five
// cohorts of wildly different cost is not a number anybody can act on.
const latRead = new Trend('lat_read_lesson', true);
const latSim = new Trend('lat_simulate', true);
const latLab = new Trend('lat_lab_submit', true);
const latContest = new Trend('lat_contest_submit', true);
const latDash = new Trend('lat_dashboard', true);

const errRead = new Rate('err_read_lesson');
const errSim = new Rate('err_simulate');
const errLab = new Rate('err_lab_submit');
const errContest = new Rate('err_contest_submit');
const errDash = new Rate('err_dashboard');

const rl = new Counter('rate_limited_total');
const rlRead = new Rate('rl_read');
const rlSim = new Rate('rl_simulate');
const rlLab = new Rate('rl_lab_submit');
const rlContest = new Rate('rl_contest_submit');
const rlDash = new Rate('rl_dashboard');

const entitlementDenials = new Counter('entitlement_denials');
const simCacheHit = new Rate('sim_cache_hit_rate');
const upstreamUnavailable = new Counter('sim_upstream_unavailable');
const creditsExhausted = new Counter('credits_exhausted');

// §9: 429 (shed) and 403 (entitlement denial) are DESIGNED outcomes, so they are
// counted separately rather than inflating http_req_failed. 503 is NOT excused —
// an upstream timeout is breakage and must show up in the error rate.
http.setResponseCallback(http.expectedStatuses(200, 201, 202, 204, 304, 403, 429));

function scenarioFor(exec_, base, peak, iterSeconds) {
  const rate = Math.max(1, Math.round(base * RATE_MULT));
  // VU budget: 10x the nominal concurrency the arrival rate needs at the
  // measured iteration cost, so that when latency grows under load the executor
  // keeps DELIVERING the requested rate instead of quietly under-delivering
  // (which would look like "the server coped" when it did not). k6 warns
  // "Insufficient VUs" if even this is not enough; that warning is reported.
  const maxVUs = Math.min(6000, Math.max(200, Math.ceil(rate * iterSeconds * 10)));
  if (MODE === 'ramp') {
    const steps = [0.25, 0.5, 1, 1.5, 2.5, 4].map((m) => ({
      duration: '90s',
      target: Math.max(1, Math.round(base * m)),
    }));
    return {
      executor: 'ramping-arrival-rate',
      exec: exec_,
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.ceil(maxVUs / 2),
      maxVUs: Math.min(6000, Math.max(200, Math.ceil(peak * 4 * iterSeconds * 10))),
      stages: [...steps, { duration: '30s', target: 0 }],
    };
  }
  return {
    executor: 'constant-arrival-rate',
    exec: exec_,
    rate,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: Math.ceil(maxVUs / 2),
    maxVUs,
    gracefulStop: '20s',
  };
}

// COHORTS lets a run isolate tiers. The full mix is the primary measurement,
// but with the simulation cohort in it the kernel saturates first and every
// other number becomes "how long did you queue behind the kernel" rather than a
// property of that tier. Running the mix WITHOUT `editing` is the only way to
// see where the gateway / Postgres / Redis path saturates on its own. Both runs
// are reported; neither is presented as the platform's capacity by itself.
const ENABLED = new Set((__ENV.COHORTS || 'reading,editing,labs,contest,dashboards').split(','));
const ALL = {
  reading: scenarioFor('reading', STEADY.reading, PEAK.reading, 0.05),
  editing: scenarioFor('editing', STEADY.editing, PEAK.editing, 1.0),
  labs: scenarioFor('labs', STEADY.labs, PEAK.labs, 0.1),
  contest: scenarioFor('contest', STEADY.contest, PEAK.contest, 0.1),
  dashboards: scenarioFor('dashboards', STEADY.dashboards, PEAK.dashboards, 0.1),
};
const SCENARIOS = {};
for (const k of Object.keys(ALL)) if (ENABLED.has(k)) SCENARIOS[k] = ALL[k];

export const options = {
  discardResponseBodies: false,
  scenarios: SCENARIOS,
  // Thresholds are REPORTED, never aborted on: the point of the run is to see
  // the whole saturation curve, including the part where it fails.
  thresholds: {
    // top-line claim: "p99 < 300 ms on read paths"
    lat_read_lesson: ['p(50)<300', 'p(95)<300', 'p(99)<300'],
    lat_dashboard: ['p(99)<300'],
    // §4: T-B is a 900 ms synchronous budget
    lat_simulate: ['p(95)<900'],
    // §6 step 1: "Budget: 12 ms" for the contest submit write path
    lat_contest_submit: ['p(99)<300'],
    err_read_lesson: ['rate<0.01'],
    err_simulate: ['rate<0.02'],
    err_lab_submit: ['rate<0.02'],
    err_contest_submit: ['rate<0.02'],
    err_dashboard: ['rate<0.01'],
  },
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'avg'],
};

// ------------------------------------------------------------------ helpers
function classify(res, latTrend, errRate, rlRate) {
  latTrend.add(res.timings.duration);
  const s = res.status;
  if (s === 429) { rl.add(1); rlRate.add(1); errRate.add(0); return 'rate_limited'; }
  rlRate.add(0);
  if (s === 403) { errRate.add(0); return 'denied'; }
  const ok = s >= 200 && s < 300;
  errRate.add(ok ? 0 : 1);
  return ok ? 'ok' : `err_${s}`;
}

// ------------------------------------------------------------------ cohorts

/** 55%: reading a lesson. The gateway hands out the pointer + entitlement
 *  decision; §5 says catalog is "small, read-mostly, fully cached". */
export function reading() {
  const user = userForIteration('reading', exec.scenario.iterationInTest);
  const slug = LESSON_SLUGS[Math.floor(Math.random() * LESSON_SLUGS.length)];
  const res = http.get(`${BASE_URL}/catalog/lessons/${slug}`, {
    headers: authHeaders(user, exec.vu.idInTest),
    tags: { name: 'GET /catalog/lessons/:slug' },
  });
  classify(res, latRead, errRead, rlRead);
}

/** 22% of users, but only the ~8% of their simulations that reach the server. */
export function editing() {
  const user = userForIteration('editing', exec.scenario.iterationInTest);
  const qubits = pickQubits();
  const res = http.post(`${BASE_URL}/simulate`, JSON.stringify(simBody(qubits)), {
    headers: authHeaders(user, exec.vu.idInTest, { 'Content-Type': 'application/json' }),
    tags: { name: 'POST /simulate', qubits: String(qubits), tier: tierFor(qubits), mix: SIM_MIX },
  });
  const outcome = classify(res, latSim, errSim, rlSim);
  if (res.status === 403) {
    // Either the §7 qubit ceiling (free 16 / pro 28 / teams 30 / campus 32) or
    // an exhausted credit balance. Both are correct behaviour, not breakage.
    entitlementDenials.add(1, { plan: user.plan, qubits: String(qubits) });
    if (String(res.body).indexOf('credits-exhausted') >= 0) creditsExhausted.add(1);
  }
  if (res.status === 503) upstreamUnavailable.add(1, { qubits: String(qubits) });
  if (res.status === 200) {
    // The kernel reports cache state in the body (`cached`), not a header; the
    // old script looked for a non-existent `x-sim-cache` header.
    simCacheHit.add(String(res.body).indexOf('"cached":true') >= 0);
  }
  void outcome;
}

/** 12%: a lab submission. Async by design — 202 + job id, graded off the
 *  request path (§1 "Sandboxed execution, async"). */
export function labs() {
  const user = userForIteration('labs', exec.scenario.iterationInTest);
  const lessonId = GRADABLE_LESSON_IDS[Math.floor(Math.random() * GRADABLE_LESSON_IDS.length)];
  const res = http.post(
    `${BASE_URL}/labs/submit`,
    JSON.stringify({
      lessonId,
      language: 'qiskit',
      // Unique per submission: §6-style duplicate detection exists on the lab
      // path too, and identical sources across users would measure the
      // anti-cheat index rather than the submission path.
      source: `# lt ${exec.vu.idInTest}/${exec.scenario.iterationInTest}\nfrom qiskit import QuantumCircuit\nqc = QuantumCircuit(3, 3)\nqc.h(0)\nqc.cx(0, 1)\nqc.measure(range(3), range(3))\n`,
      qubits: 3,
      backend: 'statevector',
    }),
    {
      headers: authHeaders(user, exec.vu.idInTest, {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey('lab'),
      }),
      tags: { name: 'POST /labs/submit' },
    },
  );
  classify(res, latLab, errLab, rlLab);
}

/** 8%: steady-state contest submissions. The 90 s deadline burst is
 *  contest-burst.js; this is the 44 rps background rate. */
export function contest() {
  const user = userForIteration('contest', exec.scenario.iterationInTest);
  const p = CONTEST.problems[Math.floor(Math.random() * CONTEST.problems.length)];
  const res = http.post(
    `${BASE_URL}/contests/${CONTEST.slug}/submit`,
    JSON.stringify({
      problemId: p.id,
      language: 'qiskit',
      source: `#LOADTEST_ACCEPT ${exec.vu.idInTest}/${exec.scenario.iterationInTest}\n`,
    }),
    {
      headers: authHeaders(user, exec.vu.idInTest, {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey('cs'),
      }),
      tags: { name: 'POST /contests/:slug/submit' },
    },
  );
  classify(res, latContest, errContest, rlContest);
}

/** 3%: the dashboard. Reads mastery + streak + xp + review queue in one call. */
export function dashboards() {
  const user = userForIteration('dashboards', exec.scenario.iterationInTest);
  const res = http.get(`${BASE_URL}/progress/overview`, {
    headers: authHeaders(user, exec.vu.idInTest),
    tags: { name: 'GET /progress/overview' },
  });
  classify(res, latDash, errDash, rlDash);
}

export function handleSummary(data) {
  const label = __ENV.RUN_LABEL || `mult${RATE_MULT}`;
  return {
    stdout: textSummary(data),
    [`results/${label}-summary.json`]: JSON.stringify(data, null, 2),
  };
}

// k6's own text summary, imported lazily so the import failure mode is obvious.
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

void WARMUP;
void STEADY_TOTAL;

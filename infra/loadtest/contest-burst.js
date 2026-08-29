// contest-burst.js
//
// Simulates the §6 90-second contest submission burst (4,000 users -> ~1,300
// rps) and then VERIFIES correctness, not just throughput. See
// docs/architecture/system-design.md §6 and README.md for the full picture.
//
// -----------------------------------------------------------------------
// THE ISOLATED-MEMORY CONSTRAINT (read this before touching the plan logic)
// -----------------------------------------------------------------------
// Each k6 VU is a separate JS runtime with its own heap - there is no shared
// mutable memory between VUs during a run. That means a naive "push every
// submission into an array as we send it" design does not work: 300 VUs
// each have their OWN empty array, and nothing merges them.
//
// The fix used here is to never need cross-VU collection at all:
//
//   1. `buildSubmissionPlan()` is a PURE function of `PLAN_SEED` - given the
//      same seed it produces the exact same ordered array of planned
//      submissions (who, which problem, which attempt number, and whether
//      that attempt is designed to be ACCEPTED or REJECTED - see the
//      GRADING CONTRACT below). It is wrapped in a `SharedArray`, which k6
//      builds ONCE and then shares READ-ONLY across every VU - this is the
//      "SharedArray for INPUT" the spec calls for.
//   2. Every VU, on every iteration, deterministically maps itself onto a
//      row of that plan via `exec.scenario.iterationInTest` - the
//      constant-arrival-rate executor's own globally-sequential iteration
//      counter (unique across all VUs, not just within one VU). No
//      cross-VU coordination is needed because k6 already assigns that
//      index for us.
//   3. Because the plan is a pure function of one number (`PLAN_SEED`), the
//      "submission log" does not need to be reassembled from scattered
//      per-VU state after the fact - `handleSummary()` just calls the SAME
//      pure function again (or, equivalently, re-reads the already-built
//      `SUBMISSION_PLAN` from module scope, since `handleSummary` runs in
//      the same script and therefore sees the same top-level bindings) and
//      writes it to `results/contest-submission-log.json`. This is the
//      "deterministic seed so the log can be regenerated in handleSummary"
//      referred to in the spec.
//   4. What DOES need to cross the VU boundary - actual server responses,
//      timings, rate-limit hits - travels the only way k6 supports moving
//      data out of a VU: custom metrics (Trend/Counter/Rate), which k6
//      aggregates centrally regardless of which VU emitted them. That is
//      why `x_server_time_ms`, `leaderboard_monotonicity_violations` and
//      `standings_diff_count` are metrics, not plain variables.
//
// -----------------------------------------------------------------------
// GRADING CONTRACT (environment prerequisite - see README "Prerequisites")
// -----------------------------------------------------------------------
// For the accept/reject outcome of a submission to be something THIS SCRIPT
// can predict deterministically (required for phase 3's exact-score diff),
// the contest's problems must use a test-only grader key, `loadtest-echo`,
// with the following contract: a submission's `source` is ACCEPTED iff it
// contains the literal marker `#LOADTEST_ACCEPT`, and REJECTED otherwise
// (e.g. containing `#LOADTEST_REJECT`). This must never be wired up outside
// a load-testing environment. `setup()` below creates the contest's
// problems with this grader key; if problems are instead pre-seeded by an
// operator, they must use the same grader key for phase 3 to be meaningful.
//
// -----------------------------------------------------------------------
// SCORING / PENALTY CONTRACT (must match the server under test - §6)
// -----------------------------------------------------------------------
//   - Only the FIRST accepted submission for a given (user, problem) counts
//     (SETNX semantics on `solved:{contest}:{user}:{problem}`, §6). Points
//     for that problem are added exactly once.
//   - A (user, problem) pair that is never accepted within the burst
//     contributes 0 points and 0 penalty.
//   - penaltySeconds (for a solved problem) = elapsedSeconds of the
//     ACCEPTED submission (seconds from contest start) + 1200 (20 minutes)
//     PER PRIOR non-accepted attempt on that same problem. 1200s is
//     `contest.contests.penalty_seconds_per_reject`'s schema default
//     (apps/api/src/db/schema/contest.ts) - the classic ICPC penalty rule.
//   - A user's total penalty is the sum of per-problem penalties, for
//     solved problems only.
//   - Standings order: descending points, then ascending penalty (matches
//     the packed Redis ZSET score `(points<<32) | (2^32 - penalty_seconds)`
//     described in §5 - higher points first, then lower penalty first).

import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { WebSocket } from 'k6/experimental/websockets';
import { Trend, Counter } from 'k6/metrics';
import { BASE_URL, WS_URL, SCALE, RQ_TOKEN } from './lib/config.js';
import { checkOk, checkStrict } from './lib/checks.js';
import { mulberry32 } from './lib/prng.js';

// ---------------------------------------------------------------------------
// Config (§1 contest cohort: "8% / 4,000 / 1 submit per 90s / 44 rps, bursts
// to ~1,300 rps at deadline"; §6: "a 90-second submission burst from
// 4,000-50,000 users")
// ---------------------------------------------------------------------------

const CONTEST_ID = __ENV.CONTEST_ID || 'loadtest-burst-contest';
const CONTEST_USERS = Math.max(10, Math.round(4000 * SCALE));
const BURST_RATE = Math.max(1, Math.round(1300 * SCALE));
const BURST_DURATION_SECONDS = 90; // §6, verbatim - not scaled: it's a duration, not a rate.
const PROBLEM_LABELS = ['A', 'B', 'C', 'D', 'E'];
const PROBLEM_POINTS = { A: 100, B: 200, C: 300, D: 400, E: 500 };
const PENALTY_SECONDS_PER_REJECT = 1200; // 20 min - see SCORING CONTRACT above.
const PLAN_SEED = Number(__ENV.CONTEST_SEED || '1337');

function authHeaders() {
  return RQ_TOKEN ? { Authorization: `Bearer ${RQ_TOKEN}` } : {};
}

// ---------------------------------------------------------------------------
// Deterministic submission plan - see the isolated-memory comment at top.
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of planned submissions. Pure function of the
 * module-level consts above (all of which derive from PLAN_SEED / env vars
 * fixed for the whole run) - same inputs, same output, every time.
 *
 * Plan size is engineered to equal the burst's nominal iteration count
 * (BURST_RATE * BURST_DURATION_SECONDS) so that, in the common case, every
 * plan row is used by exactly one submission and vice versa. Call sites
 * still index with `% plan.length` defensively in case k6 delivers a
 * slightly different number of iterations than the nominal target (e.g.
 * VU exhaustion under extreme SCALE values).
 */
function buildSubmissionPlan() {
  const rand = mulberry32(PLAN_SEED);
  const entries = [];
  const targetTotal = BURST_RATE * BURST_DURATION_SECONDS;

  let u = 0;
  let p = 0;
  while (entries.length < targetTotal) {
    const userId = `contestant-${u % CONTEST_USERS}`;
    const problemLabel = PROBLEM_LABELS[p % PROBLEM_LABELS.length];

    // Attempt story for this (user, problem) pair, seeded deterministically:
    // most contestants solve on the first or second try; a thin tail never
    // solves it at all within the burst window (the interesting case for
    // "0 points, 0 penalty for an unsolved problem").
    const roll = rand();
    let priorRejects;
    let solves;
    if (roll < 0.55) {
      priorRejects = 0;
      solves = true;
    } else if (roll < 0.8) {
      priorRejects = 1;
      solves = true;
    } else if (roll < 0.92) {
      priorRejects = 2;
      solves = true;
    } else if (roll < 0.97) {
      priorRejects = 3;
      solves = true;
    } else {
      priorRejects = 1 + Math.floor(rand() * 2); // 1-2 reject-only attempts
      solves = false;
    }

    const totalAttempts = priorRejects + (solves ? 1 : 0);
    for (let a = 0; a < totalAttempts && entries.length < targetTotal; a++) {
      const isFinal = a === totalAttempts - 1;
      const plannedVerdict = isFinal && solves ? 'accepted' : 'rejected';
      const elapsedSeconds = Math.min(
        BURST_DURATION_SECONDS - 1,
        Math.floor((a / Math.max(1, totalAttempts)) * BURST_DURATION_SECONDS + rand() * 5),
      );
      entries.push({
        userId,
        problemLabel,
        attemptNumber: a,
        plannedVerdict,
        elapsedSeconds,
        // Client-generated Idempotency-Key (§9): deterministic so a retried
        // iteration (or a re-run with the same seed) is idempotent for real.
        idempotencyKey: `${CONTEST_ID}:${userId}:${problemLabel}:${a}`,
      });
    }

    u++;
    if (u % CONTEST_USERS === 0) p++;
  }

  return entries;
}

const SUBMISSION_PLAN = new SharedArray('contest-submission-plan', buildSubmissionPlan);

function sourceForVerdict(problemLabel, plannedVerdict) {
  const marker = plannedVerdict === 'accepted' ? '#LOADTEST_ACCEPT' : '#LOADTEST_REJECT';
  return [
    `# loadtest-echo fixture for problem ${problemLabel}`,
    marker,
    'from qiskit import QuantumCircuit',
    'qc = QuantumCircuit(1, 1)',
    'qc.h(0)',
    'qc.measure(0, 0)',
  ].join('\n');
}

/**
 * Replay the plan under the SCORING/PENALTY CONTRACT documented above.
 * Pure function - used both by `teardown()` (to feed the threshold-checked
 * `standings_diff_count` metric during the run) and by `handleSummary()`
 * (to produce the human-readable report file).
 */
function computeExpectedStandings(plan) {
  const perUser = new Map();
  for (const entry of plan) {
    if (!perUser.has(entry.userId)) perUser.set(entry.userId, new Map());
    const perProblem = perUser.get(entry.userId);
    if (!perProblem.has(entry.problemLabel)) perProblem.set(entry.problemLabel, []);
    perProblem.get(entry.problemLabel).push(entry);
  }

  const standings = [];
  for (const [userId, perProblem] of perUser.entries()) {
    let points = 0;
    let penaltySeconds = 0;
    for (const attempts of perProblem.values()) {
      const sorted = attempts.slice().sort((a, b) => a.attemptNumber - b.attemptNumber);
      let priorRejects = 0;
      for (const attempt of sorted) {
        if (attempt.plannedVerdict === 'accepted') {
          points += PROBLEM_POINTS[attempt.problemLabel] || 0;
          penaltySeconds += attempt.elapsedSeconds + priorRejects * PENALTY_SECONDS_PER_REJECT;
          break;
        }
        priorRejects++;
      }
    }
    standings.push({ userId, points, penaltySeconds });
  }

  standings.sort((a, b) => b.points - a.points || a.penaltySeconds - b.penaltySeconds);
  standings.forEach((row, i) => {
    row.rank = i + 1;
  });
  return standings;
}

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

// §6 budget: "Budget: 12 ms" server-side handling time for POST
// /contests/:id/submit. A 12ms *http_req_duration* p99 is unrealistic over
// a real network (that budget is server processing time only), so we read
// the server's own reported timing from a response header instead.
export const submitServerTimeMs = new Trend('x_server_time_ms', true);

// §6 "monotone": a user's rank must never move backwards across successive
// polls of the same contest state.
export const leaderboardMonotonicityViolations = new Counter('leaderboard_monotonicity_violations');

// §9 SLO: "contest scoring correctness: 100%, verified by a post-contest
// replay." Any diff between our locally-replayed expected standings and
// the server's actual final standings increments this.
export const standingsDiffCount = new Counter('standings_diff_count');

// §6 broadcaster: "Clients receive deltas, plus a full snapshot every 30s
// to self-heal." Lag = now - the delta/snapshot's own server timestamp.
export const contestBroadcastLagMs = new Trend('contest_broadcast_lag_ms', true);

// Counted (not just checked) so a report can state exactly how many
// snapshots arrived within tolerance of the 30s cadence.
export const contestSnapshotSelfHeals = new Counter('contest_snapshot_self_heals');

export const contestSubmissionsSent = new Counter('contest_submissions_sent');

http.setResponseCallback(http.expectedStatuses(200, 201, 202, 204, 304, 409, 429));

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
// Registration (phase 1) happens in setup(), which blocks all scenarios
// below until it completes - so submit_burst/leaderboard_poll/ws_broadcast
// all start together, at t=0 of the "real" run, exactly as phase 2+3
// require. Their durations overlap: submit_burst runs the 90s burst;
// leaderboard_poll and ws_broadcast keep running an extra drain window so
// grader workers (async, §6 step 2) can catch up before phase 3 checks the
// final state in teardown().

const DRAIN_SECONDS = 30; // headroom for grader lag (§11 grader_lag_seconds) before we call it "final".

function vuBudget(rate, avgIterSeconds) {
  const maxVUs = Math.max(10, Math.ceil(rate * avgIterSeconds * 1.5));
  const preAllocatedVUs = Math.max(5, Math.ceil(maxVUs * 0.6));
  return { preAllocatedVUs, maxVUs };
}

const submitBudget = vuBudget(BURST_RATE, 0.15);

export const options = {
  setupTimeout: '10m',
  teardownTimeout: '2m',
  scenarios: {
    submit_burst: {
      executor: 'constant-arrival-rate',
      exec: 'submitBurst',
      rate: BURST_RATE,
      timeUnit: '1s',
      duration: `${BURST_DURATION_SECONDS}s`,
      preAllocatedVUs: submitBudget.preAllocatedVUs,
      maxVUs: submitBudget.maxVUs,
    },
    leaderboard_poll: {
      executor: 'constant-arrival-rate',
      exec: 'pollLeaderboard',
      rate: 2,
      timeUnit: '1s',
      duration: `${BURST_DURATION_SECONDS + DRAIN_SECONDS}s`,
      preAllocatedVUs: 2,
      maxVUs: 4,
    },
    ws_broadcast: {
      executor: 'per-vu-iterations',
      exec: 'wsListener',
      vus: 1,
      iterations: 1,
      maxDuration: `${BURST_DURATION_SECONDS + DRAIN_SECONDS + 30}s`,
    },
  },
  thresholds: {
    leaderboard_monotonicity_violations: ['count==0'],
    standings_diff_count: ['count==0'],
    x_server_time_ms: ['p(99)<12'],
    'http_req_duration{name:contest_submit}': ['p(99)<500'],
    contest_broadcast_lag_ms: ['p(95)<1000'],
  },
};

// ---------------------------------------------------------------------------
// Phase 1: setup() - register N virtual contestants, open the contest.
// ---------------------------------------------------------------------------

export function setup() {
  // Best-effort: create/open the contest with the loadtest-echo grading
  // contract described above. A real deployment may instead pre-seed the
  // contest via fixtures/migrations and have it already `running` - we log
  // a non-2xx response rather than failing setup, since the exact
  // admin-provisioning contract is deployment-specific (README
  // "Prerequisites").
  const openRes = http.post(
    `${BASE_URL}/contests/${CONTEST_ID}/open`,
    JSON.stringify({
      problems: PROBLEM_LABELS.map((label) => ({
        label,
        points: PROBLEM_POINTS[label],
        graderKey: 'loadtest-echo',
      })),
    }),
    {
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      tags: { name: 'contest_open' },
    },
  );
  if (openRes.status >= 400) {
    console.warn(
      `[contest-burst] setup: contest open returned ${openRes.status} - assuming the contest ` +
        `is pre-seeded with a compatible loadtest-echo grader (see README Prerequisites)`,
    );
  }

  // Register CONTEST_USERS virtual contestants, batched for setup-phase
  // throughput (sequential registration of, at full §1 scale, 4,000 users
  // would otherwise dominate the run's wall-clock time).
  const BATCH_SIZE = 50;
  let registered = 0;
  for (let i = 0; i < CONTEST_USERS; i += BATCH_SIZE) {
    const batch = [];
    const end = Math.min(i + BATCH_SIZE, CONTEST_USERS);
    for (let j = i; j < end; j++) {
      batch.push([
        'POST',
        `${BASE_URL}/contests/${CONTEST_ID}/register`,
        JSON.stringify({ userId: `contestant-${j}` }),
        { headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()), tags: { name: 'contest_register' } },
      ]);
    }
    const responses = http.batch(batch);
    registered += responses.filter((r) => r.status === 200 || r.status === 201 || r.status === 409).length;
  }

  console.log(`[contest-burst] setup: registered ${registered}/${CONTEST_USERS} contestants for contest ${CONTEST_ID}`);

  return {
    contestId: CONTEST_ID,
    contestStartAtMs: Date.now(),
    registered,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: 90s constant-arrival-rate submission burst.
// ---------------------------------------------------------------------------

export function submitBurst(data) {
  const idx = exec.scenario.iterationInTest;
  const plan = SUBMISSION_PLAN[idx % SUBMISSION_PLAN.length];
  const source = sourceForVerdict(plan.problemLabel, plan.plannedVerdict);

  const res = http.post(
    `${BASE_URL}/contests/${data.contestId}/submit`,
    JSON.stringify({ problemLabel: plan.problemLabel, language: 'qiskit', source }),
    {
      headers: Object.assign(
        {
          'Content-Type': 'application/json',
          'Idempotency-Key': plan.idempotencyKey,
          // Test-only impersonation header, avoiding a per-iteration login
          // round trip for each of the 4,000 synthetic contestants (which
          // would itself dominate the 90s burst window and make ~1,300 rps
          // unreachable). See README "Prerequisites".
          'X-Loadtest-User-Id': plan.userId,
        },
        authHeaders(),
      ),
      tags: { name: 'contest_submit' },
    },
  );

  checkOk(res, [200, 201, 202], 'contest_burst:submit');
  contestSubmissionsSent.add(1, { verdict: plan.plannedVerdict });

  const serverTimeHeader = res.headers['X-Server-Time-Ms'] || res.headers['x-server-time-ms'];
  if (serverTimeHeader !== undefined) {
    submitServerTimeMs.add(Number(serverTimeHeader));
  }
}

// ---------------------------------------------------------------------------
// Phase 3a (continuous, during phases 2+3): leaderboard monotonicity.
// ---------------------------------------------------------------------------
// A single dedicated VU (rate 2/s, preAllocatedVUs/maxVUs small) polls the
// standings repeatedly. Module-level state persists across this VU's own
// iterations (k6 module scope is per-VU, and this scenario owns exactly one
// VU), so `previousRanks` below is a true "successive polls by the same
// observer" history - exactly what "monotone across successive polls"
// requires.

let previousRanks = {};

export function pollLeaderboard(data) {
  const res = http.get(`${BASE_URL}/contests/${data.contestId}/standings`, {
    headers: authHeaders(),
    tags: { name: 'contest_standings_poll' },
  });
  checkOk(res, [200], 'contest_burst:poll_standings');
  if (res.status !== 200) return;

  let rows;
  try {
    const body = res.json();
    rows = Array.isArray(body) ? body : body.rows;
  } catch (_e) {
    return;
  }
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    const prevRank = previousRanks[row.userId];
    if (prevRank !== undefined && row.rank > prevRank) {
      leaderboardMonotonicityViolations.add(1, { userId: row.userId });
    }
    previousRanks[row.userId] = row.rank;
  }
}

// ---------------------------------------------------------------------------
// Phase 3b (continuous, during phases 2+3): WebSocket delta path.
// ---------------------------------------------------------------------------

export function wsListener(data) {
  return new Promise((resolve) => {
    const url = `${WS_URL}/ws/contest/${data.contestId}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error(`[contest-burst] ws connect failed: ${e}`);
      resolve();
      return;
    }

    let lastSnapshotAt = null;
    let snapshotCount = 0;
    const listenDurationMs = (BURST_DURATION_SECONDS + DRAIN_SECONDS) * 1000;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch (_e) {
        resolve();
      }
    }, listenDurationMs);

    ws.addEventListener('open', () => {
      console.log(`[contest-burst] ws connected to ${url}`);
    });

    ws.addEventListener('message', (event) => {
      const now = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_e) {
        return;
      }

      if (typeof msg.serverTimestampMs === 'number') {
        contestBroadcastLagMs.add(now - msg.serverTimestampMs, { type: msg.type || 'delta' });
      }

      if (msg.type === 'snapshot') {
        snapshotCount++;
        if (lastSnapshotAt !== null) {
          const gap = now - lastSnapshotAt;
          // §6: "a full snapshot every 30 s to self-heal." Generous
          // tolerance (45s) above the nominal cadence before treating a gap
          // as a self-heal miss rather than jitter.
          if (gap <= 45000) {
            contestSnapshotSelfHeals.add(1);
          } else {
            console.warn(`[contest-burst] snapshot self-heal gap ${gap}ms exceeds 45s tolerance`);
          }
        }
        lastSnapshotAt = now;
      }
    });

    ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve();
    });

    ws.addEventListener('error', (e) => {
      console.error(`[contest-burst] ws error: ${JSON.stringify(e)}`);
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Phase 3c: teardown() - exact final score verification.
// ---------------------------------------------------------------------------
// Runs once, after every scenario above has finished (i.e. after the burst
// AND the drain window), and BEFORE k6 finalises threshold pass/fail - so
// `standings_diff_count.add(...)` here is still eligible to trip the
// `standings_diff_count: ['count==0']` threshold declared above.

export function teardown(data) {
  const expected = computeExpectedStandings(SUBMISSION_PLAN);

  const res = http.get(`${BASE_URL}/contests/${data.contestId}/standings`, {
    headers: authHeaders(),
    tags: { name: 'contest_standings_final' },
  });
  checkStrict(res, [200], 'contest_burst:final_standings');

  let actualRows = [];
  if (res.status === 200) {
    try {
      const body = res.json();
      actualRows = Array.isArray(body) ? body : body.rows || [];
    } catch (_e) {
      actualRows = [];
    }
  }

  const actualByUser = new Map();
  for (const row of actualRows) {
    actualByUser.set(row.userId, row);
  }

  let diffCount = 0;
  for (const expectedRow of expected) {
    const actual = actualByUser.get(expectedRow.userId);
    if (
      !actual ||
      actual.points !== expectedRow.points ||
      actual.penaltySeconds !== expectedRow.penaltySeconds
    ) {
      diffCount++;
    }
  }

  standingsDiffCount.add(diffCount);
  console.log(
    `[contest-burst] teardown: ${diffCount} standings diffs out of ${expected.length} expected rows ` +
      `(${actualRows.length} rows returned by the server)`,
  );
}

// ---------------------------------------------------------------------------
// Report output
// ---------------------------------------------------------------------------

export function handleSummary(data) {
  // `SUBMISSION_PLAN` is re-derived from the same pure `buildSubmissionPlan`
  // that produced it at VU-init time - see the isolated-memory comment at
  // the top of this file for why that is sufficient to "regenerate the
  // log" without collecting anything from the (isolated-memory) VUs that
  // actually sent the requests.
  const plan = Array.from(SUBMISSION_PLAN);
  const expected = computeExpectedStandings(SUBMISSION_PLAN);

  let actualStandings = [];
  try {
    const res = http.get(`${BASE_URL}/contests/${CONTEST_ID}/standings`, {
      headers: authHeaders(),
      tags: { name: 'contest_standings_report' },
    });
    if (res.status === 200) {
      const body = res.json();
      actualStandings = Array.isArray(body) ? body : body.rows || [];
    }
  } catch (e) {
    console.warn(`[contest-burst] handleSummary: could not fetch final standings for the report (${e})`);
  }

  const monotonicityViolations = data.metrics.leaderboard_monotonicity_violations
    ? data.metrics.leaderboard_monotonicity_violations.values.count
    : null;
  const diffCount = data.metrics.standings_diff_count ? data.metrics.standings_diff_count.values.count : null;

  const report = {
    contestId: CONTEST_ID,
    planSeed: PLAN_SEED,
    burstRate: BURST_RATE,
    burstDurationSeconds: BURST_DURATION_SECONDS,
    submissionPlanSize: plan.length,
    expectedStandings: expected,
    actualStandings,
    leaderboardMonotonicityViolations: monotonicityViolations,
    standingsDiffCount: diffCount,
  };

  return {
    stdout:
      `contest-burst: ${plan.length} planned submissions, ` +
      `${monotonicityViolations ?? 'n/a'} monotonicity violations, ` +
      `${diffCount ?? 'n/a'} standings diffs\n`,
    'results/contest-submission-log.json': JSON.stringify(plan, null, 2),
    'results/contest-standings-report.json': JSON.stringify(report, null, 2),
  };
}

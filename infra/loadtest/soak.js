// soak.js
//
// 2-hour steady-state soak test at the §1 steady origin rate, watching for
// memory growth in `api` and `quantum-kernel` via their /metrics endpoints.
//
// -----------------------------------------------------------------------
// Reused workload
// -----------------------------------------------------------------------
// The five cohort request functions (`reading`, `editing`, `labs`,
// `contest`, `dashboards`) are imported directly from main.js instead of
// being reimplemented here, so the actual HTTP calls this soak test makes
// are the SAME calls main.js's steady-state stage makes - only the
// executor/duration/rate differ (a flat 2h hold here, vs. main.js's
// warm-up/steady/peak/ramp-down staged ramp). Importing main.js also runs
// its module-level side effects once (the §1 arithmetic log line and the
// `http.setResponseCallback` marking 429/403 as expected, non-failing
// statuses) - both are wanted here too, so no need to redeclare them.
//
// -----------------------------------------------------------------------
// The quartile-mean trick, and why it's needed
// -----------------------------------------------------------------------
// The task: "fail if the last-quartile mean [resident memory] exceeds the
// first-quartile mean by more than 10%", computed in handleSummary().
//
// k6's handleSummary() only receives AGGREGATED per-metric stats
// (avg/min/med/max/p90/p95 for a Trend) - never the raw, time-ordered list
// of samples a Trend collected. That means we cannot bucket "the first 25%
// of samples by time" after the fact inside handleSummary; the bucketing
// has to happen AT SCRAPE TIME, by writing each sample into one of FOUR
// SEPARATE Trend metrics (one per quartile) chosen by the scrape's own
// sequence number. handleSummary then just reads two ordinary, fully
// supported aggregates - q0's avg and q3's avg - and compares them. No
// custom instrumentation beyond "which of 4 Trends does this sample go
// into" is required.
//
// A second, related k6 limitation: thresholds (options.thresholds) can
// only express a condition on ONE metric's own stats (e.g. "p(99)<300");
// they cannot compare metric A's average against metric B's average. A
// "last-quartile mean vs. first-quartile mean" check is inherently a
// two-metric comparison, so it CANNOT be wired up as a native k6 threshold
// no matter how the samples are bucketed. This is exactly why the task
// says to implement the comparison in handleSummary rather than in
// `options.thresholds`: handleSummary is the only place in a k6 script
// with the freedom to run arbitrary comparison logic across metrics. The
// consequence: an actual growth violation does NOT flip k6's own overall
// pass/fail exit code (there is no k6 threshold to fail) - it fails
// `results/soak-report.json`'s `memoryGrowthOverallPass` field instead, and
// is logged via `console.error` so it's visible in run output. See
// README.md ("how to interpret results") for how CI should consume this.

import http from 'k6/http';
import exec from 'k6/execution';
import { Trend } from 'k6/metrics';
import { SCALE, API_METRICS_URL, KERNEL_URL } from './lib/config.js';
import { reading, editing, labs, contest, dashboards } from './main.js';

// Re-exported so `k6 run soak.js` can still execute the cohort iterations
// (k6 resolves `exec: 'reading'` etc. against THIS module's exports, not
// main.js's - a re-export makes the imported function available under the
// same name from soak.js itself).
export { reading, editing, labs, contest, dashboards };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SOAK_DURATION = '2h';
const SOAK_DURATION_SECONDS = 2 * 60 * 60;
const SCRAPE_INTERVAL_SECONDS = 30;
const QUARTILE_COUNT = 4;
const TOTAL_SCRAPES = Math.floor(SOAK_DURATION_SECONDS / SCRAPE_INTERVAL_SECONDS); // 240
const QUARTILE_SIZE = Math.ceil(TOTAL_SCRAPES / QUARTILE_COUNT); // 60

// Mirrors main.js's §1 steady-state cohort arithmetic - see main.js for the
// full derivation (611 reading / 110 editing-server / 50 labs / 44 contest
// / 75 dashboards = 890 rps modeled steady total). Duplicated here (rather
// than imported) because these are plain numeric constants, not exported
// bindings from main.js; keep in sync with main.js if §1 changes.
const READING_STEADY = 611;
const EDITING_SERVER_STEADY = 110;
const LABS_STEADY = 50;
const CONTEST_STEADY = 44;
const DASHBOARDS_STEADY = 75;

function scaledRate(base) {
  return Math.max(1, Math.round(base * SCALE));
}

function vuBudget(rate, avgIterSeconds) {
  const maxVUs = Math.max(10, Math.ceil(rate * avgIterSeconds * 1.5));
  const preAllocatedVUs = Math.max(5, Math.ceil(maxVUs * 0.6));
  return { preAllocatedVUs, maxVUs };
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, '_');
}

// ---------------------------------------------------------------------------
// Metrics-scrape target services (SPEC.md: api /metrics on :9464, quantum-
// kernel /metrics on :8100). `extraGauges` lists candidate metric names in
// preference order - the first one found in a given scrape's response body
// is used; if none are found, the scrape simply contributes nothing to
// that service's "extra" quartile Trends (the "guarded so a missing metric
// does not fail the run" requirement).
// ---------------------------------------------------------------------------

const SERVICES = [
  {
    name: 'api',
    metricsUrl: `${API_METRICS_URL}/metrics`,
    extraGauges: ['nodejs_active_handles_total', 'nodejs_active_handles'],
  },
  {
    name: 'quantum-kernel',
    metricsUrl: `${KERNEL_URL}/metrics`,
    extraGauges: ['python_gc_objects_collected_total'],
  },
];

// Pre-declared at init/module scope (k6 requires custom metrics to be
// created here, not inside a VU's exec function) - one Trend per
// (service, {memory,extra}, quartile) combination.
const trends = {};
for (const svc of SERVICES) {
  const key = safeName(svc.name);
  trends[svc.name] = {
    memory: Array.from({ length: QUARTILE_COUNT }, (_, q) => new Trend(`mem_${key}_q${q}`, true)),
    extra: Array.from({ length: QUARTILE_COUNT }, (_, q) => new Trend(`extra_${key}_q${q}`, true)),
  };
}

function parsePromMetric(text, metricName) {
  // Matches Prometheus text-exposition lines for `metricName`, with or
  // without a `{...}` label set, e.g.:
  //   process_resident_memory_bytes 123456789
  //   nodejs_active_handles_total{type="Timeout"} 4
  // Sums across label combinations (fine for a scalar gauge with no
  // labels, and a reasonable aggregate for a labelled one).
  const re = new RegExp(`^${metricName}(?:\\{[^}]*\\})?\\s+([0-9eE+\\-.]+)\\s*$`, 'gm');
  let match;
  let sum = null;
  while ((match = re.exec(text)) !== null) {
    const v = Number(match[1]);
    if (!Number.isNaN(v)) {
      sum = (sum === null ? 0 : sum) + v;
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Scenario: metrics scrape, every 30s, for the whole soak duration.
// ---------------------------------------------------------------------------

export function scrapeMetrics() {
  const idx = exec.scenario.iterationInTest;
  const quartile = Math.min(QUARTILE_COUNT - 1, Math.floor(idx / QUARTILE_SIZE));

  for (const svc of SERVICES) {
    const res = http.get(svc.metricsUrl, { tags: { name: `scrape_${safeName(svc.name)}_metrics` } });
    if (res.status !== 200) {
      console.warn(`[soak] ${svc.name} metrics scrape #${idx} returned ${res.status}`);
      continue;
    }

    const mem = parsePromMetric(res.body, 'process_resident_memory_bytes');
    if (mem !== null) {
      trends[svc.name].memory[quartile].add(mem);
    } else {
      console.warn(`[soak] ${svc.name} scrape #${idx}: process_resident_memory_bytes not found`);
    }

    for (const gaugeName of svc.extraGauges) {
      const val = parsePromMetric(res.body, gaugeName);
      if (val !== null) {
        trends[svc.name].extra[quartile].add(val);
        break;
      }
      // else: try the next candidate name; if none match, this scrape
      // contributes nothing for the "extra" gauge - not a failure.
    }
  }
}

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------

const readingBudget = vuBudget(scaledRate(READING_STEADY), 0.15);
const editingBudget = vuBudget(scaledRate(EDITING_SERVER_STEADY), 0.6);
const labsBudget = vuBudget(scaledRate(LABS_STEADY), 0.25);
const contestBudget = vuBudget(scaledRate(CONTEST_STEADY), 0.2);
const dashboardsBudget = vuBudget(scaledRate(DASHBOARDS_STEADY), 0.15);

export const options = {
  scenarios: {
    reading: {
      executor: 'constant-arrival-rate',
      exec: 'reading',
      rate: scaledRate(READING_STEADY),
      timeUnit: '1s',
      duration: SOAK_DURATION,
      preAllocatedVUs: readingBudget.preAllocatedVUs,
      maxVUs: readingBudget.maxVUs,
    },
    editing: {
      executor: 'constant-arrival-rate',
      exec: 'editing',
      rate: scaledRate(EDITING_SERVER_STEADY),
      timeUnit: '1s',
      duration: SOAK_DURATION,
      preAllocatedVUs: editingBudget.preAllocatedVUs,
      maxVUs: editingBudget.maxVUs,
    },
    labs: {
      executor: 'constant-arrival-rate',
      exec: 'labs',
      rate: scaledRate(LABS_STEADY),
      timeUnit: '1s',
      duration: SOAK_DURATION,
      preAllocatedVUs: labsBudget.preAllocatedVUs,
      maxVUs: labsBudget.maxVUs,
    },
    contest: {
      executor: 'constant-arrival-rate',
      exec: 'contest',
      rate: scaledRate(CONTEST_STEADY),
      timeUnit: '1s',
      duration: SOAK_DURATION,
      preAllocatedVUs: contestBudget.preAllocatedVUs,
      maxVUs: contestBudget.maxVUs,
    },
    dashboards: {
      executor: 'constant-arrival-rate',
      exec: 'dashboards',
      rate: scaledRate(DASHBOARDS_STEADY),
      timeUnit: '1s',
      duration: SOAK_DURATION,
      preAllocatedVUs: dashboardsBudget.preAllocatedVUs,
      maxVUs: dashboardsBudget.maxVUs,
    },
    metrics_scrape: {
      executor: 'constant-arrival-rate',
      exec: 'scrapeMetrics',
      rate: 1,
      timeUnit: `${SCRAPE_INTERVAL_SECONDS}s`,
      duration: SOAK_DURATION,
      preAllocatedVUs: 2,
      maxVUs: 4,
    },
  },
  thresholds: {
    // Same headline read-path budget as main.js, held for the full 2h
    // instead of just the steady stage - a soak test's whole point is that
    // this DOESN'T degrade over time.
    'http_req_duration{scenario:reading}': ['p(99)<300'],
    checks: ['rate>0.99'],
    // The memory/handle/GC-growth quartile comparison is NOT expressible
    // as a k6 threshold (see the file-level comment above) - it is
    // computed and reported in handleSummary/results/soak-report.json
    // instead.
  },
};

// ---------------------------------------------------------------------------
// Report output
// ---------------------------------------------------------------------------

function readTrendAvg(data, name) {
  const m = data.metrics[name];
  // A Trend that never received a single .add() call is simply ABSENT from
  // data.metrics (verified empirically against k6 v0.55.0) - so a missing
  // entry, not a zero/NaN value, is how "no samples" shows up here. This
  // is exactly the "guarded so a missing metric does not fail the run"
  // behaviour for the optional nodejs/python gauges.
  if (!m || !m.values || typeof m.values.avg !== 'number' || Number.isNaN(m.values.avg)) return null;
  return m.values.avg;
}

export function handleSummary(data) {
  const report = {
    generatedAt: new Date().toISOString(),
    soakDurationSeconds: SOAK_DURATION_SECONDS,
    scrapeIntervalSeconds: SCRAPE_INTERVAL_SECONDS,
    quartileScrapeCount: QUARTILE_SIZE,
    services: {},
  };

  let anyGrowthViolation = false;
  let anyComparisonMade = false;

  for (const svc of SERVICES) {
    const key = safeName(svc.name);
    const memQ1 = readTrendAvg(data, `mem_${key}_q0`);
    const memQ4 = readTrendAvg(data, `mem_${key}_q3`);
    const extraQ1 = readTrendAvg(data, `extra_${key}_q0`);
    const extraQ4 = readTrendAvg(data, `extra_${key}_q3`);

    const memGrowthRatio = memQ1 && memQ4 !== null ? memQ4 / memQ1 : null;
    const memPass = memGrowthRatio === null ? null : memGrowthRatio <= 1.1;
    if (memPass !== null) {
      anyComparisonMade = true;
      if (!memPass) anyGrowthViolation = true;
    }

    const extraGrowthRatio = extraQ1 && extraQ4 !== null ? extraQ4 / extraQ1 : null;
    const extraPass = extraGrowthRatio === null ? null : extraGrowthRatio <= 1.1;
    if (extraPass !== null && !extraPass) anyGrowthViolation = true;

    report.services[svc.name] = {
      processResidentMemoryBytes: {
        firstQuartileMean: memQ1,
        lastQuartileMean: memQ4,
        growthRatio: memGrowthRatio,
        pass: memPass, // null = no data collected (e.g. scrapes all failed)
      },
      extraGauge: {
        // Which candidate name actually matched is not tracked separately
        // per-quartile; `candidates` documents what we looked for.
        candidates: svc.extraGauges,
        firstQuartileMean: extraQ1,
        lastQuartileMean: extraQ4,
        growthRatio: extraGrowthRatio,
        pass: extraPass, // null = metric not exposed by this service - NOT a failure
      },
    };
  }

  report.memoryGrowthOverallPass = anyComparisonMade ? !anyGrowthViolation : null;
  report.note =
    'This comparison cannot be expressed as a k6 threshold (cross-metric ' +
    'comparisons are not supported by options.thresholds) - see the ' +
    'file-level comment in soak.js. Treat `memoryGrowthOverallPass === false` ' +
    'as a hard fail in CI by checking this file, not k6\'s own exit code.';

  if (report.memoryGrowthOverallPass === false) {
    console.error(
      '[soak] MEMORY/HANDLE/GC GROWTH CHECK FAILED - last-quartile mean exceeds ' +
        'first-quartile mean by more than 10% for at least one tracked metric. ' +
        'See results/soak-report.json.',
    );
  } else if (report.memoryGrowthOverallPass === null) {
    console.warn('[soak] no memory-growth comparison could be made (no successful scrapes?)');
  } else {
    console.log('[soak] memory/handle/GC growth check passed for all metrics with data.');
  }

  return {
    stdout: `soak: memoryGrowthOverallPass=${report.memoryGrowthOverallPass}\n`,
    'results/soak-report.json': JSON.stringify(report, null, 2),
  };
}

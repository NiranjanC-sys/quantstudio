# RedQuant k6 load-test suite

Load tests for the capacity model, contest correctness guarantees, and
long-running stability claims in `docs/architecture/system-design.md`. Three
scripts:

| Script | What it does | §-refs |
|---|---|---|
| `main.js` | Mixed workload: 5 cohorts (reading/editing/labs/contest/dashboards) as independent `ramping-arrival-rate` scenarios, warm-up → steady → peak → ramp-down | §1, §4, §9, §11 |
| `contest-burst.js` | The 90s, ~1,300 rps contest submission burst, plus a correctness replay against the server's final standings | §6, §9 |
| `soak.js` | 2h steady-state hold + `/metrics` memory-growth watch on `api` and `quantum-kernel` | §1, §11 |

```
infra/loadtest/
├── main.js
├── contest-burst.js
├── soak.js
├── lib/
│   ├── config.js     BASE_URL / WS_URL / SCALE / auth / plan constants
│   ├── auth.js       synthetic-user session acquisition
│   ├── checks.js      shared check() wrappers (429-aware)
│   ├── circuits.js    T-A/T-B/T-C boundary circuit-IR fixtures
│   └── prng.js       deterministic PRNG (contest-burst.js, soak.js)
├── results/
│   ├── README.md
│   ├── REPORT-TEMPLATE.md
│   └── .gitkeep
└── README.md          (this file)
```

## Prerequisites - environment contract this suite assumes

These scripts predate a fully-implemented backend (at the time of writing,
`apps/api` and `apps/quantum-kernel` are schema-and-scaffolding only). To keep
the suite runnable and meaningful once real routes exist, it assumes a small,
explicitly test-only contract. Anyone wiring these scripts up against a real
environment needs the target to satisfy the following:

1. **`POST /auth/dev-session`** - mints a session for an arbitrary synthetic
   `{userId, email, plan}` without a full OIDC/passkey/SAML handshake.
   Non-prod only. Fallback: set `RQ_TOKEN` to a pre-seeded bearer token and
   the suite uses `Authorization: Bearer $RQ_TOKEN` instead (see
   `lib/auth.js`).
2. **`X-Loadtest-User-Id` header** (`contest-burst.js` only) - lets the
   single `RQ_TOKEN` service identity submit a request "as" any of the
   4,000 synthetic contestants without a per-submission login round trip
   (which would itself make the ~1,300 rps burst target unreachable).
   Non-prod only.
3. **A `loadtest-echo` grader key** - a contest problem graded with this key
   deterministically ACCEPTS a submission whose `source` contains the
   literal marker `#LOADTEST_ACCEPT`, and REJECTS otherwise. Without this,
   `contest-burst.js`'s phase-3 exact-score verification has no way to know
   in advance what the grader *should* decide, and the "verifies
   correctness" half of that test is meaningless. `contest-burst.js`'s
   `setup()` tries to create the contest and its problems with this grader
   key via `POST /contests/:id/open`; if that call fails (e.g. the
   environment pre-seeds contests via fixtures instead), `setup()` logs a
   warning and continues on the assumption the pre-seeded contest already
   uses `loadtest-echo`.
4. Response shape assumptions used by the checks/parsers in this suite:
   - `GET /contests/:id/standings` returns either a bare array of
     `{userId, rank, points, penaltySeconds}` rows, or `{rows: [...]}`.
   - `POST /simulate` returns `200` synchronously, or `202 {jobId}` for the
     §9 degradation-ladder "queued" case, pollable at
     `GET /simulate/jobs/:jobId`.
   - Simulation responses carry an `x-sim-cache: hit|miss` header (§4 Redis
     result cache).
   - Contest submission responses carry an `x-server-time-ms` header (§6's
     12ms server-time budget - see "Interpreting results" below for why we
     assert on this instead of `http_req_duration`).
   - The contest WebSocket path is `{WS_URL}/ws/contest/:id` and sends JSON
     frames shaped `{type: 'delta'|'snapshot', serverTimestampMs, ...}`.

   None of these are load-bearing for §1/§6/§9/§11 as *design* - they are
   this suite's best-effort guess at the wire contract, and the first thing
   to fix if a real run 404s/mis-parses everything.

## Running locally against docker compose

```sh
BASE_URL=http://localhost:3001 SCALE=0.01 k6 run main.js
```

- `BASE_URL` - the api-gateway's HTTP+WS port (3001 per the infra spec).
  `WS_URL`/`KERNEL_URL`/`API_METRICS_URL` default sensibly off `BASE_URL`
  (see `lib/config.js`) but can be overridden the same way.
- `SCALE` - multiplies every arrival-rate target. **Default is 1** (full §1
  fleet scale - meant for a real cluster/cell run, not your laptop).

  > **A docker-compose stack is a single Postgres, a single Redis, and one
  > `quantum-kernel` container - roughly one pod's worth of the fleet, not
  > 50,000 concurrent users' worth.** `SCALE=0.01` targets ~9 rps steady /
  > ~22 rps peak in `main.js` (890/2221 rps × 0.01) - already enough to
  > exercise every code path (cache hits, entitlement denials, rate
  > limiting, T-A/T-B/T-C routing) without saturating a laptop.
  > **Anything above `SCALE=0.02` against compose measures your laptop's
  > single Postgres/Redis/kernel container falling over, not RedQuant's
  > architecture** - compose has none of §2's cell sharding, §5's
  > read-replica fan-out, or §1's fleet sizing, so there is nothing in that
  > topology capacity-planned to survive higher load. Treat any local
  > "peak" numbers as a smoke test, never as a capacity result.

`contest-burst.js` and `soak.js` take the same `BASE_URL`/`SCALE`, plus:

```sh
# contest-burst.js
CONTEST_ID=loadtest-burst-contest CONTEST_SEED=1337 RQ_TOKEN=<token> \
  BASE_URL=http://localhost:3001 SCALE=0.01 k6 run contest-burst.js

# soak.js - runs for a real 2 hours regardless of SCALE (only the rate scales)
BASE_URL=http://localhost:3001 SCALE=0.01 k6 run soak.js
```

## Running against a cluster

Distributed execution via [k6-operator](https://github.com/grafana/k6-operator),
one `TestRun` per script, targeting a specific cell:

```yaml
apiVersion: k6.io/v1alpha1
kind: TestRun
metadata:
  name: redquant-main-loadtest
  namespace: redquant-loadtest
  labels:
    redquant.io/cell: "1"
    redquant.io/git-sha: "${GIT_SHA}"
spec:
  parallelism: 8            # k6-operator shards arrival-rate targets across pods
  script:
    configMap:
      name: redquant-loadtest-scripts
      file: main.js
  runner:
    image: ghcr.io/redquant/k6-loadtest:${GIT_SHA}
    env:
      - name: BASE_URL
        value: "https://api.cell-1.redquant.internal"
      - name: SCALE
        value: "0.25"        # e.g. 1 cell ≈ 12,500 / 50,000 ≈ 0.25 of fleet-wide §1 numbers
      - name: GIT_SHA
        value: "${GIT_SHA}"
      - name: CELL_ID
        value: "cell-1"
      - name: RQ_TOKEN
        valueFrom:
          secretKeyRef:
            name: redquant-loadtest-token
            key: token
  arguments: >-
    --out experimental-prometheus-rw=http://prometheus.observability:9090/api/v1/write
    --tag git_sha=${GIT_SHA}
    --tag cell_id=cell-1
    --tag run_id=${RUN_ID}
```

Run it: `kubectl apply -f testrun-main.yaml`, then `kubectl logs -f -l
k6_cr=redquant-main-loadtest -n redquant-loadtest`.

Notes:

- `parallelism` shards `ramping-arrival-rate`/`constant-arrival-rate` targets
  evenly across runner pods - k6-operator divides each scenario's rate by
  `parallelism`, so the numbers in `main.js`/`contest-burst.js`/`soak.js`
  don't need to change.
- **Always tag runs with the git sha and cell id** (`--tag git_sha=... --tag
  cell_id=...`, plus the `redquant.io/git-sha`/`redquant.io/cell` labels on
  the `TestRun` itself) - a load-test result with no attached git sha is not
  reproducible, and §2's cell-based blast-radius model means "cell 1 at
  3,500 rps" and "cell 3 at 3,500 rps" are two different claims about two
  different Postgres-replica/Redis-shard placements, not one claim run
  twice.
- `--out experimental-prometheus-rw` ships every k6 metric (not just
  thresholds) into the same Prometheus this fleet already alerts from
  (§11), so a load-test run's `sim_cache_hit_rate`/`contest_broadcast_lag_ms`
  can sit on the exact same dashboards as production traffic for
  side-by-side comparison.
- `contest-burst.js`'s `setup()` does real (batched) HTTP registration calls
  for `4000 * SCALE` contestants before the timed scenarios start - set
  `--out` and the `TestRun`'s own timeout generously (`setupTimeout: '10m'`
  is already set in the script) for a full-scale run.

## Interpreting results

### What a PASS actually proves - and does not

- **`main.js` passing** proves the *directly modeled* cohort traffic (890
  rps steady / 2,221 rps peak, summed - see the arithmetic comment at the
  top of `main.js`) meets its latency/error/cache budgets. It does **not**
  prove the full §1 origin envelope (1,500/3,500 rps) was reproduced - the
  gap is explicitly the contest deadline burst (tested separately) plus
  unmodeled auxiliary traffic (WebSocket control frames for 32k sockets,
  health checks, cache revalidation). For a claim about the *combined*
  envelope, run `main.js`'s peak stage concurrently with `contest-burst.js`.
- **`contest-burst.js` passing** proves: (a) the submit path holds up under
  a 1,300 rps/90s burst, (b) every leaderboard poll this run made saw
  monotonically non-decreasing rank per user, and (c) the server's final
  standings for this run's synthetic contest exactly match a local replay
  of the documented scoring/penalty contract. It does **not** prove the
  grader's actual quantum-circuit correctness logic is right (submissions
  use the test-only `loadtest-echo` marker grader, not real circuits) -
  that is a correctness property of the grader itself, out of scope for a
  load generator.
- **`soak.js` passing** (i.e. `results/soak-report.json`'s
  `memoryGrowthOverallPass: true`) proves resident memory (and, if exposed,
  Node.js active-handle count / Python GC-collected-objects count) didn't
  grow by more than 10% from the first to the last quarter of a 2-hour run
  under steady load. It does **not** prove there is no slow leak on a
  longer horizon (a leak that only compounds meaningfully over days/weeks
  can look flat across any single 2h window), and it does not by itself
  distinguish "no leak" from "leak masked by the process being recycled/
  restarted mid-run" - cross-check against pod restart counts for the run.

### Threshold reference

| Threshold | Script | Meaning | § source |
|---|---|---|---|
| `http_req_duration{scenario:reading}` p(99)<300, **abortOnFail** | `main.js` | Read-path latency budget | top-level target, §1 |
| `sim_32q_duration` p(99)<2000, **abortOnFail** | `main.js` | 32-qubit simulation, full user-visible wait (incl. any 202+poll) | top-level target, §4 |
| `time_to_first_amplitude` p(95)<120 | `main.js` | RUM budget for first rendered amplitude (k6-side approximation, see comment in `editing()`) | §11 |
| `checks` rate>0.99 | `main.js`, `soak.js` | General check hygiene across all cohorts | n/a (suite hygiene) |
| `http_req_failed{scenario:X}` rate<0.01-0.02 | `main.js` | Per-cohort real-error rate (429/403 excluded - see below) | derived from §1 cohort mix |
| `rate_limited_ratio` rate<0.05 | `main.js` | §9 rate limiting sheds load but shouldn't dominate it | §9 |
| `leaderboard_monotonicity_violations` count==0 | `contest-burst.js` | Rank must never regress across polls of the same contest state | §6 "monotone" |
| `standings_diff_count` count==0 | `contest-burst.js` | Server's final standings == local replay of the scoring contract | §6, §9 SLO "contest scoring correctness: 100%" |
| `x_server_time_ms` p(99)<12 | `contest-burst.js` | Submit handler's own reported server-side time (not network RTT) | §6 "Budget: 12 ms" |
| `http_req_duration{name:contest_submit}` p(99)<500 | `contest-burst.js` | Realistic end-to-end submit latency over a real network | §6 (network-realistic proxy for the 12ms server budget) |
| `contest_broadcast_lag_ms` p(95)<1000 | `contest-burst.js` | WS delta/snapshot delivery lag | §11 `contest_broadcast_lag_ms` |
| `http_req_duration{scenario:reading}` p(99)<300 (soak, non-abort) | `soak.js` | Read-path budget must hold for the full 2h, not just the ramp | top-level target, §1 |
| memory/handle/GC growth ≤10% (q4 mean / q1 mean) | `soak.js` | **Not a k6 threshold** - computed in `handleSummary`, reported in `results/soak-report.json`'s `memoryGrowthOverallPass` (see the file-level comment in `soak.js` for why a cross-metric comparison can't be a native k6 threshold) | task requirement |

429 (rate-limited) and 403 (entitlement-denied) are marked as *expected*
statuses (`http.setResponseCallback`) in both `main.js` and
`contest-burst.js`, so they do not count against `http_req_failed` - they
are tracked separately (`rate_limited_ratio`, `entitlement_denials`)
precisely so a threshold failure always means genuine breakage (5xx,
connection errors, unexpected 4xx), never "the rate limiter is doing its
job."

### Mapping a threshold failure to the §9 degradation ladder

A load test's job is partly to tell you *which rung of the ladder* a
failure signature implies:

| Signature in this suite | Ladder step (§9) | Flag |
|---|---|---|
| `sim_32q_duration`/editing p99 rising, more `202 {jobId}` responses in `main.js`'s editing scenario | 1. Kernel saturated → T-B/T-C queued | `DEGRADE_SIM_ASYNC` |
| Editing entitlement_denials spike specifically on 22-30 qubit circuits that used to succeed | 2. Server sims restricted to ≤22 qubits | `DEGRADE_SIM_MAX_QUBITS=22` |
| (not exercised by this suite - no AI tutor traffic modeled) | 3. AI tutor retrieval-only fallback | `DEGRADE_TUTOR_RETRIEVAL_ONLY` |
| (not exercised by this suite - no analytics traffic modeled) | 4. ClickHouse down, analytics delayed | `DEGRADE_ANALYTICS_DELAYED` |
| (not exercised by this suite - no billing traffic modeled) | 5. Stripe down, billing queued | `DEGRADE_BILLING_QUEUE` |
| `http_req_failed` spike to 503 across all cohorts simultaneously, `Retry-After` header present | 6. Postgres primary failover | client should retry idempotently via `Idempotency-Key` - already how `labs`/`contest` submissions in this suite are built |

### k6 metric → §11 domain metric / dashboard mapping

| k6 metric (this suite) | §11 domain metric / dashboard | Notes |
|---|---|---|
| `sim_cache_hit_rate` | `sim_cache_hit_ratio` | Read from the `x-sim-cache` response header on `/simulate` calls |
| `sim_32q_duration`, editing scenario latency | `sim_queue_depth` (proxy) | A rising `sim_32q_duration` with more 202s is the client-visible symptom of a growing `sim_queue_depth` |
| `contest_broadcast_lag_ms` | `contest_broadcast_lag_ms` | Same name/semantics by design - directly comparable to the production dashboard |
| `entitlement_denials` | `entitlement_denial_rate` | Counter here vs. a rate in prod; divide by iteration count for a comparable ratio |
| `standings_diff_count`, `leaderboard_monotonicity_violations` | contest scoring correctness SLO (§9, 100%) | These ARE the synthetic version of the "post-contest replay that recomputes standings from the submission log and diffs against the snapshot" the SLO describes |
| `process_resident_memory_bytes` (soak, per service) | fleet memory dashboards | Same Prometheus metric name/semantics as the services already expose |
| dashboards this suite feeds into | "one per user journey" (§11) | `main.js`'s 5 scenarios line up 1:1 with "read a lesson" (reading), "run a lab" (labs), "join a contest" (contest); editing/dashboards are additional journeys not explicitly named in §11 but present in §1's cohort model |

## Fixture library (`lib/circuits.js`)

Five canned circuit-IR payloads at 8/14/22/28/32 qubits, chosen to sit
exactly on the §4 T-A/T-B boundary (14), the Pro-plan qubit ceiling (28,
§7), and the Campus-plan/T-C ceiling (32, §7) - see the file-level comment
in `lib/circuits.js` for the full reasoning and why generation is seeded
(cache-hit-friendly, and reproducible for debugging).

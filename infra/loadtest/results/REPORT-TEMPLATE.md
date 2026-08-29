# RedQuant load-test report - `<date>` / `<target>`

Copy this file to `results/<date>-<target>-<git-sha>.md` and fill it in.
`<placeholders>` mark fields to replace; delete rows/sections that don't
apply to the script(s) actually run.

## Run metadata

| Field | Value |
|---|---|
| Date | `<YYYY-MM-DD>` |
| Scripts run | `<main.js / contest-burst.js / soak.js>` |
| Target | `<local docker compose \| cell-N \| staging \| ...>` |
| Git sha | `<git-sha>` |
| SCALE | `<e.g. 1, 0.25, 0.01>` |
| k6 version | `<k6 version output>` |
| Duration | `<wall-clock start - end>` |
| Operator | `<name>` |

## §1 capacity table - measured vs. budget

Fill in every row `system-design.md` §1 specifies, even ones this run didn't
push hard - mark those `n/a (not saturated)` rather than leaving blank, so a
reader knows it was considered.

| Metric | §1 budget | Measured (this run) | Delta | Notes |
|---|---|---|---|---|
| Reading lessons - origin rps | 611 steady | `<>` | `<>` | |
| Editing circuits - server-side sim rps | 110 steady / 400 peak | `<>` | `<>` | §4: >=92% never leaves the browser - this is the server-visible ~8% only |
| Running labs - submit rps | 50 steady | `<>` | `<>` | |
| Contest - steady submit rps | 44 steady | `<>` | `<>` | Deadline burst is a separate row below |
| Contest - deadline burst rps | ~1,300 / 90s | `<>` | `<>` | From `contest-burst.js`, not `main.js` |
| Dashboards/social - rps | 75 steady | `<>` | `<>` | |
| Origin total - steady | ~1,500 rps | `<>` | `<>` | This suite's directly-modeled cohorts sum to 890 rps steady - see `main.js` header comment for the documented gap |
| Origin total - peak | ~3,500 rps | `<>` | `<>` | Modeled cohorts sum to ~2,221 rps peak - burst + auxiliary traffic account for the rest |
| WebSocket concurrent sockets | 32,000 | `<>` | `<>` | |
| Server-side sims | 110/s steady, 400/s peak | `<>` | `<>` | |
| Sandbox executions | 50/s steady, 250/s at deadline | `<>` | `<>` | |
| Postgres reads | ~9,000 QPS | `<>` | `<>` | Not directly measured by k6 - pull from Postgres/PgBouncer dashboards for the run window |
| Postgres writes | ~450 QPS | `<>` | `<>` | ditto |
| Redis ops/s | ~28,000 | `<>` | `<>` | ditto |
| 32-qubit sim latency | p99 < 2s | `<>` | `<>` | `sim_32q_duration` |
| Read-path latency | p99 < 300ms | `<>` | `<>` | `http_req_duration{scenario:reading}` |

### Fleet sizing observed vs. §1 table

| Tier | §1 steady replicas | §1 peak (HPA max) | Observed replicas at run peak | CPU% at run peak | Notes |
|---|---|---|---|---|---|
| web | 12 | 40 | `<>` | `<>` | |
| api | 16 | 60 | `<>` | `<>` | |
| quantum-kernel | 24 | 120 | `<>` | `<>` | |
| quantum-kernel-heavy | 0 (KEDA min) | 12 | `<>` | `<>` | T-C, 31-40 qubit |
| sandbox-runner | 20 | 100 | `<>` | `<>` | |
| grader | 8 | 40 (KEDA) | `<>` | `<>` | queue-depth driven |
| ai-tutor | 6 | 24 | `<>` | `<>` | not exercised by this suite |

## Threshold pass/fail table

| Threshold | Pass/Fail | Observed value | § source |
|---|---|---|---|
| `http_req_duration{scenario:reading}` p(99)<300 | `<>` | `<>` | top-level target, §1 |
| `sim_32q_duration` p(99)<2000 | `<>` | `<>` | top-level target, §4 |
| `time_to_first_amplitude` p(95)<120 | `<>` | `<>` | §11 |
| `checks` rate>0.99 | `<>` | `<>` | suite hygiene |
| `http_req_failed{scenario:reading}` rate<0.01 | `<>` | `<>` | derived |
| `http_req_failed{scenario:editing}` rate<0.02 | `<>` | `<>` | derived |
| `http_req_failed{scenario:labs}` rate<0.02 | `<>` | `<>` | derived |
| `http_req_failed{scenario:contest}` rate<0.02 | `<>` | `<>` | derived |
| `http_req_failed{scenario:dashboards}` rate<0.01 | `<>` | `<>` | derived |
| `rate_limited_ratio` rate<0.05 | `<>` | `<>` | §9 |
| `leaderboard_monotonicity_violations` count==0 | `<>` | `<>` | §6 |
| `standings_diff_count` count==0 | `<>` | `<>` | §6, §9 SLO |
| `x_server_time_ms` p(99)<12 | `<>` | `<>` | §6 |
| `http_req_duration{name:contest_submit}` p(99)<500 | `<>` | `<>` | §6 (network-realistic proxy) |
| `contest_broadcast_lag_ms` p(95)<1000 | `<>` | `<>` | §11 |
| memory/handle/GC growth <=10% (`soak-report.json`) | `<>` | `<>` | task requirement (not a k6 threshold - see `soak.js`) |

## Latency percentiles per cohort

| Cohort | p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|
| reading | `<>` | `<>` | `<>` | `<>` | `<>` |
| editing | `<>` | `<>` | `<>` | `<>` | `<>` |
| labs | `<>` | `<>` | `<>` | `<>` | `<>` |
| contest (steady) | `<>` | `<>` | `<>` | `<>` | `<>` |
| contest (burst submit) | `<>` | `<>` | `<>` | `<>` | `<>` |
| dashboards | `<>` | `<>` | `<>` | `<>` | `<>` |

## Saturation observations

- First threshold to degrade, and at what offered load: `<>`
- Any §9 degradation-ladder step observed in flight (which flag, and
  evidence): `<>`
- VU/arrival-rate under-delivery (`dropped_iterations` > 0, meaning offered
  load exceeded `maxVUs`): `<>`
- Any 5xx/connection-error clustering (which service, which time window):
  `<>`

## Domain metrics at peak (§11)

| Metric | Value at peak | Source |
|---|---|---|
| `sim_cache_hit_ratio` | `<>` | `sim_cache_hit_rate` (k6) |
| `sim_queue_depth` | `<>` | prod dashboard (proxy: `sim_32q_duration` trend, editing 202-rate) |
| `grader_lag_seconds` | `<>` | prod dashboard |
| `contest_broadcast_lag_ms` | `<>` | `contest_broadcast_lag_ms` (k6) |
| `entitlement_denial_rate` | `<>` | `entitlement_denials` (k6, divide by iterations) |
| `tutor_cost_usd_per_hour` | n/a | not exercised by this suite |

## Degradation-ladder steps triggered

| Step | Flag | Triggered? | Evidence |
|---|---|---|---|
| 1. Kernel saturated -> T-B/T-C queued | `DEGRADE_SIM_ASYNC` | `<>` | `<>` |
| 2. Server sims restricted to <=22 qubits | `DEGRADE_SIM_MAX_QUBITS=22` | `<>` | `<>` |
| 3. AI tutor retrieval-only | `DEGRADE_TUTOR_RETRIEVAL_ONLY` | n/a (not exercised) | |
| 4. ClickHouse down, analytics delayed | `DEGRADE_ANALYTICS_DELAYED` | n/a (not exercised) | |
| 5. Stripe down, billing queued | `DEGRADE_BILLING_QUEUE` | n/a (not exercised) | |
| 6. Postgres primary failover | (client retry via `Idempotency-Key`) | `<>` | `<>` |

## Sign-off / action items

- Overall verdict: `<PASS / FAIL / PASS WITH CAVEATS>`
- Blocking issues (must fix before next run): `<>`
- Non-blocking follow-ups: `<>`
- Owner(s) for follow-ups: `<>`
- Next run planned: `<date/trigger>`

Signed off by: `<name>`, `<date>`

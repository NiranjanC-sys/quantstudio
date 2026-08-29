# RedQuant observability stack

Config for Prometheus, the OpenTelemetry Collector, Loki, Tempo, and Grafana.
This directory is consumed two ways:

1. **docker-compose** (`infra/docker/docker-compose.yml`) bind-mounts the
   files here straight into vanilla upstream images — no Operator, no CRDs.
2. **In-cluster** (`infra/k8s`), where the Prometheus Operator, Loki/Tempo
   Helm charts, or the Grafana Operator consume equivalent config generated
   from the same source of truth (see "Running in-cluster" below).

Everything here is derived from `docs/architecture/system-design.md`,
especially §11 (Observability). Read that first if something here looks
arbitrary — it probably maps to a specific number or requirement in §1/§4/§6/
§9/§10.

## Layout

```
infra/observability/
├── prometheus/
│   ├── prometheus.yml              # scrape config, both modes (see below)
│   └── rules/
│       ├── recording-rules.yml     # redquant:* recording rules (cheap dashboards/alerts)
│       └── alerts.yml              # SLO burn-rate + domain-metric alerts
├── otel/
│   └── otel-collector-config.yaml  # receivers/processors/tail_sampling/exporters
├── loki/
│   └── loki-config.yaml            # single-binary/filesystem Loki 3.x
├── tempo/
│   └── tempo.yaml                  # Tempo 2.x, local backend + metrics_generator
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/datasources.yaml  # Prometheus/Loki/Tempo + correlations
│   │   └── dashboards/dashboards.yaml    # file-provider pointed at ../dashboards
│   └── dashboards/
│       ├── journey-read-a-lesson.json
│       ├── journey-run-a-lab.json
│       └── journey-join-a-contest.json
└── README.md                       # this file
```

## How docker-compose mounts these files

`infra/docker/docker-compose.yml` mounts (read-only) exactly these paths into
the corresponding containers:

| Host path | Container | Mount point |
|---|---|---|
| `prometheus/prometheus.yml` | `prometheus` | `/etc/prometheus/prometheus.yml` |
| `prometheus/rules/` | `prometheus` | `/etc/prometheus/rules/` |
| `otel/otel-collector-config.yaml` | `otel-collector` | `/etc/otel/otel-collector-config.yaml` |
| `loki/loki-config.yaml` | `loki` | `/etc/loki/loki-config.yaml` |
| `tempo/tempo.yaml` | `tempo` | `/etc/tempo/tempo.yaml` |
| `grafana/provisioning/` | `grafana` | `/etc/grafana/provisioning/` |
| `grafana/dashboards/` | `grafana` | `/etc/grafana/dashboards/` |

No other paths are used — if you rename or move a file here, update the
compose mounts too (owned by a different agent/PR; coordinate the rename).

Bring the stack up with `docker compose -f infra/docker/docker-compose.yml up
-d prometheus otel-collector loki tempo grafana` (or just `up -d` for
everything). Prometheus's web UI is on `:9090`, Grafana on `:3000` (mapped to
a host port — check the compose file), Tempo query on `:3200`, Loki on
`:3100`.

## Running the same configs in-cluster

Nothing here is compose-specific by accident — each file has a commented
"MODE 2 / cluster" section or an equivalent note:

- **`prometheus/prometheus.yml`**: the `scrape_configs` static jobs are
  MODE 1 (active). A commented `kubernetes_sd_configs` block (`role: pod` and
  `role: endpoints`) is MODE 2 — uncomment it (and drop or leave the static
  jobs disabled) to run this same file as a plain Prometheus in-cluster. In
  practice, prefer the Prometheus Operator (`infra/k8s`) with
  `ServiceMonitor`/`PodMonitor` CRs instead of hand-uncommenting this, but the
  block is kept accurate and working so `promtool check config` always
  passes against both modes.
- **`prometheus/rules/*.yml`**: these are plain `groups:` rule files, which
  is exactly the format both vanilla Prometheus (compose) and
  `promtool check rules` expect. The cluster environment wraps equivalent
  rules in `PrometheusRule` CRs owned by another workstream (`infra/k8s`) —
  keep the two in sync when a rule changes; the recording-rule and alert
  *names* are the contract between them.
- **`otel/otel-collector-config.yaml`**: the `k8sattributes` processor is
  commented out (needs a `serviceAccount` with RBAC to read pods) — uncomment
  it and add it to the `traces`/`metrics`/`logs` pipelines' `processors:`
  lists for cluster mode. Everything else (receivers, tail_sampling,
  exporters) is identical between modes.
- **`loki/loki-config.yaml`** and **`tempo/tempo.yaml`**: both ship with a
  `local`/`filesystem` storage backend for compose. `tempo.yaml` has a
  commented S3 `storage.trace` block ready for prod (swap `backend: local` ->
  `backend: s3` and fill in the bucket/credentials via
  `external-secrets.io/v1beta1 ExternalSecret`, per the repo-wide secrets
  convention — never literal credentials in this file). Loki's cluster
  deployment should move to the `grafana/loki` Helm chart's distributed mode
  and swap `common.storage.filesystem` for S3-backed chunk/index storage; the
  `schema_config` (tsdb + v13) and `limits_config` here are still the right
  starting point.
- **`grafana/provisioning/`**: identical in both modes — Grafana always
  reads `datasources.yaml` and `dashboards.yaml` from its provisioning
  directory, whether that directory is a compose bind mount or a ConfigMap
  volume in a Grafana Helm release.

## Metric naming conventions

- Recording rules: `redquant:<subject>:<operation>[_<window>]`, e.g.
  `redquant:read_availability:ratio_rate5m`,
  `redquant:sim_tier:share`, `redquant:grader_lag_seconds:avg5m`.
  `<subject>` is a business/domain noun (not a raw instrumentation metric
  name), so dashboards and alerts stay stable if the underlying metric is
  renamed. `<operation>` is one of `rate`, `ratio`, `avg`, `max`, `share`,
  `p50`/`p95`/`p99`. Multi-window SLI ratios append the window:
  `_rate5m`, `_rate30m`, `_rate1h`, `_rate2h`, `_rate6h`, `_rate1d`,
  `_rate3d`.
- Raw instrumentation metrics (emitted by services, not recording rules)
  follow OpenTelemetry/Prometheus convention: `<noun>_<unit>_total` for
  counters (`http_requests_total`, `submissions_committed_total`),
  `<noun>_<unit>` for gauges (`sim_queue_depth`, `grader_lag_seconds`), and
  `<noun>_<unit>_bucket`/`_sum`/`_count` for histograms
  (`http_request_duration_seconds_bucket`).
- The §11 domain metrics are used verbatim, no renaming:
  `sim_queue_depth`, `sim_cache_hit_ratio`, `grader_lag_seconds`,
  `contest_broadcast_lag_ms`, `tutor_cost_usd_per_hour`,
  `entitlement_denial_rate`.
- Alert names are `PascalCase`, describing the symptom, not the cause:
  `ReadAvailabilitySLOBurnRateFast`, `ClientSimShareBelowBudget`,
  `GraderLagCritical`.

## Label taxonomy

Every metric that can carry these should:

| Label | Meaning | Example values |
|---|---|---|
| `service` | canonical service name (see repo-root `SPEC.md` for the full table) | `web`, `api`, `quantum-kernel`, `grader`, `ai-tutor` |
| `journey` | which user journey this metric belongs to | `read_lesson`, `run_lab`, `join_contest`, `platform` (cross-cutting), `multi` (a service that serves more than one journey, e.g. `api`) |
| `cell` | deployment cell (§2: ~12,500 users each, full vertical slice) | `local` (compose), `cell-0`..`cell-3` (cluster) |
| `environment` | deploy environment | `dev`, `staging`, `prod` |

Rules of thumb:

- **Never** put a user id, session id, request id, submission id, or email
  into a label — `prometheus.yml`'s `metric_relabel_configs` actively drops
  these (`labeldrop`) as a backstop, but instrumentation should never emit
  them as labels in the first place. This is both a cardinality rule and a
  PII rule (§11: "no PII" applies to metrics and logs alike, not just traces).
- `journey` is the label the three dashboards are built around (§11: "one
  per user journey, not one per service"). When a service participates in
  more than one journey (e.g. `api` handles reads, labs, and contests), either
  emit `journey` per-request from the instrumentation (preferred — the
  gateway knows the route) or accept the `multi` placeholder label and let
  the per-journey recording rules do the `journey=` filtering downstream via
  route-based relabeling.
- `cell` should always be present, even in compose, where it is hardcoded to
  `local` via `global.external_labels.cell` in `prometheus.yml`. This keeps
  every PromQL expression identical between compose and cluster — you never
  need an `if` on whether `cell` exists.

## Adding a new journey dashboard

1. Confirm the journey has a `journey="<name>"` label value flowing through
   traces/metrics/logs. If not, that's a code change first (instrumentation),
   not a dashboard change.
2. Add any new domain-specific recording rules to
   `prometheus/rules/recording-rules.yml` under a new `- name: redquant-<journey>`
   group, following the `redquant:<subject>:<operation>` naming convention
   above. Run `promtool check rules prometheus/rules/*.yml` before
   committing.
3. Add corresponding burn-rate/threshold alerts to
   `prometheus/rules/alerts.yml` if the journey has its own SLO, or extend an
   existing group if it shares one (e.g. read latency).
4. Create `grafana/dashboards/journey-<name>.json`. Structure it as a funnel,
   top to bottom, matching the user's actual path through the journey — copy
   the shape of the three existing dashboards (a stat row of SLO/error-budget
   panels at the top, then timeseries rows in the order the user experiences
   them). Reuse the `environment` and `cell` template variables
   (`grafana/provisioning/datasources/datasources.yaml` wires the `cell`
   variable's `label_values()` query against the Prometheus datasource; no
   changes needed there for a new journey).
5. Every panel needs: a `title`, a `description` (say what it means and cite
   the system-design.md section it maps to), a correct `fieldConfig.defaults.unit`
   (`s`, `ms`, `percentunit`, `reqps`, `currencyUSD`, `none`), and — for
   anything with an explicit SLO/budget — `thresholds` steps.
6. No new file is needed for provisioning: `dashboards.yaml` already points
   at the whole `grafana/dashboards/` directory and Grafana's file provider
   picks up new JSON files automatically (`updateIntervalSeconds: 30`).
7. Validate before committing:
   ```
   python3 -c "import json,sys; [json.load(open(p)) for p in sys.argv[1:]]" grafana/dashboards/*.json
   ```
   plus a structural check that every non-`row` panel has a `title` and at
   least one `targets` entry, and the dashboard itself has `title`, non-empty
   `panels`, `schemaVersion` >= 39, and `templating`.

## Validation commands (run these before committing any change here)

```bash
# Prometheus config + rules
promtool check config infra/observability/prometheus/prometheus.yml
promtool check rules infra/observability/prometheus/rules/*.yml

# Dashboard JSON
python3 -c "import json,sys; [json.load(open(p)) for p in sys.argv[1:]]" infra/observability/grafana/dashboards/*.json

# YAML lint (see repo scratch venv or install yamllint)
yamllint -d '{extends: default, rules: {line-length: {max: 180}, comments-indentation: disable, document-start: disable, truthy: {check-keys: false}, indentation: {indent-sequences: consistent}}}' -f parsable infra/observability/

# OTel collector config (needs docker)
docker run --rm -v "$(pwd)/infra/observability/otel:/cfg" otel/opentelemetry-collector-contrib:<tag> validate --config=/cfg/otel-collector-config.yaml

# Loki config
docker run --rm -v "$(pwd)/infra/observability/loki:/etc/loki" grafana/loki:<tag> -config.file=/etc/loki/loki-config.yaml -verify-config

# Tempo config
docker run --rm -v "$(pwd)/infra/observability/tempo:/etc/tempo" grafana/tempo:<tag> -config.file=/etc/tempo/tempo.yaml -config.verify=true
```

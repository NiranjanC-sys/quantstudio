# `@redquant/api` — the API gateway

Fastify 5 on Node 22, TypeScript ESM, Drizzle ORM over Postgres 18, ioredis,
BullMQ and Zod. It is the service that owns **auth, entitlements, CRUD, rate
limits and job enqueue**, and — per
[`docs/architecture/system-design.md`](../../docs/architecture/system-design.md)
§3 — never does heavy compute. Simulation belongs to `quantum-kernel`, execution
to `sandbox-runner`, grading to the `grader` workers.

Everything below cites the section of the system design it implements. Where the
document is specific, the code is specific in the same way; where it is silent,
the decision is written down in a comment next to the code.

---

## Quick start

```bash
# from the repo root
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d postgres redis

cd apps/api
cp .env.example .env          # then edit DATABASE_URL / REDIS_URL if needed

pnpm db:migrate               # applies src/db/migrations, rolls partitions forward
pnpm db:seed                  # 8 tracks, 64 modules, 353 lessons, 4 plans, demo cohort
pnpm dev                      # http://localhost:3001
```

Smoke test:

```bash
curl localhost:3001/healthz
curl localhost:3001/readyz
curl localhost:3001/catalog/tracks
```

The seed creates a demo institution (`demo-university`, verified domain
`demo.redquant.io`, Campus subscription) with:

| Account | Role | Password |
|---|---|---|
| `instructor@demo.redquant.io` | instructor, owns cohort `qc1-autumn-2026` (join code `QC1A2026`) | `redquant-demo-password` |
| `student1@demo.redquant.io` | learner, in the cohort | `redquant-demo-password` |
| `student2@demo.redquant.io` | learner, in the cohort | `redquant-demo-password` |

---

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | `tsx watch src/server.ts` |
| `pnpm build` | `tsc -p tsconfig.json` → `dist/` |
| `pnpm start` | `node dist/server.js` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest: unit suites always, integration suites when Postgres/Redis are reachable |
| `pnpm test:unit` / `pnpm test:integration` | one half of the above |
| `pnpm db:generate` | builds, then `drizzle-kit generate` — see [Migrations](#migrations) |
| `pnpm db:migrate` | applies migrations and rolls partitions forward |
| `pnpm db:seed` | idempotent content + plan + demo-cohort seed |

---

## Layout

```
src/
  server.ts            process entry: env validation, listen, graceful shutdown
  app.ts               builds the Fastify instance (tests use this directly)
  services.ts          the service container — every connection, key and cache
  env.ts               Zod-validated configuration, parsed once at boot
  errors.ts            RFC 9457 problem+json; the only error format in the API
  telemetry.ts         OpenTelemetry tracing + Prometheus metrics (§11)
  fastify.d.ts         request/instance decorations

  routes/              one module per domain, registered in routes/index.ts
  middleware/          request context, auth, CSRF/CORS/helmet, rate limits,
                       Idempotency-Key, read-your-own-writes
  auth/                sessions, password, passkeys, TOTP, OIDC, SAML, service JWTs
  entitlements/        the §7 matrix (pure), credits, and its materialisation
  contest/             scoring (the §6 Lua path), freeze and the finaliser
  progress/            lesson completion, the DAG recompute, streaks, XP
  billing/             Stripe projection and the nightly reconciliation
  db/                  schema, migrations, migrate.ts, seed.ts
  lib/                 DAG, Glicko-2, BKT + forgetting curve, spaced repetition,
                       crypto, outbound HTTP, mailer, degradation ladder
  queues/              BullMQ producers and the job payload contracts
  redis/               connections and the Lua scripts
tests/
  unit/                pure logic — no network, no clock beyond what is injected
  integration/         real Postgres and real Redis, or skipped loudly
```

---

## Endpoints

Every route validates its input with Zod, returns `application/problem+json` on
failure, and — for mutations — accepts an `Idempotency-Key`.

### Health (`/`)
`GET /healthz` liveness (process only) · `GET /readyz` readiness (Postgres,
replica, Redis; `?verbose=true` adds queue depth) · `GET /metrics` Prometheus.

`/healthz` deliberately does not touch the database: if it did, a database blip
would make Kubernetes kill every pod in the cell.

### Auth (`/auth`) — §8
`POST /register` · `POST /login` · `POST /logout` · `GET /session` ·
`GET /sessions` · `DELETE /sessions/:sessionKey` · `DELETE /sessions` ·
`GET /providers`

`POST /magic-link` · `GET /magic-link/callback`

`GET /oauth/:provider/start` · `GET /oauth/:provider/callback` for
`google | microsoft | github | orcid | linkedin`. Google, Microsoft, ORCID and
LinkedIn are configured by OIDC discovery; GitHub is not an OpenID Provider and
is hand-configured with its profile read from the REST API. All flows use PKCE
and a single-use state in Redis; OIDC flows also carry a nonce.

`GET /saml/:org/metadata` · `GET /saml/:org/login` · `POST /saml/:org/acs`
(HTTP-POST binding, form-encoded, parsed only inside this plugin's scope).

`POST /passkeys/register/options|verify` · `POST /passkeys/login/options|verify` ·
`GET /passkeys` · `DELETE /passkeys/:credentialId`

`POST /mfa/totp/enroll|confirm` · `DELETE /mfa/totp` · `POST /mfa/challenge`

MFA is enforced at *use*, not only at login: an instructor or org admin with an
enrolled factor gets a `challengeId` from `/login` rather than a session, and a
role promotion cannot be outlived by an old session because `requireRole` checks
`mfaSatisfied` on every privileged request.

### Catalog (`/catalog`) — §5, §7
`GET /tracks` · `/tracks/:code` · `/modules/:code` · `/lessons/:slug` ·
`/concepts` (the DAG: nodes + edges) · `/concepts/:slug` · `/roadmaps` ·
`/roadmaps/:slug` · `/search?q=` · `/questions` · `/questions/:slug` ·
`/companies`

Read-mostly and fully cached: a short Redis read-through plus a long
`Cache-Control`, because §1 assumes the CDN absorbs 95% of lesson traffic.
Search runs against stored `tsvector` generated columns, so the index can never
drift from the row. Plan gating applies to *content*, never to structure — an
unentitled learner still sees that T5 exists.

### Progress (`/progress`) — §5
`GET /overview` · `/mastery` · `/next` · `/lessons/:lessonId` ·
`PATCH /lessons/:lessonId` (time-on-task heartbeat) ·
`POST /lessons/:lessonId/complete` · `GET /review-queue` ·
`POST /review-queue/:id/grade` · `GET /streak` · `PUT /streak/timezone` ·
`GET /xp` · `GET|POST /enrollments`

`POST /lessons/:id/complete` is one transaction: lesson state, XP, streak,
per-concept Bayesian knowledge tracing, review scheduling and the DAG recompute
that rewrites `progress.mastery.unlocked_lesson_ids`. The mastery row's
`version` column is an optimistic lock, so a concurrent completion aborts rather
than writing a frontier computed from stale input.

`GET /next` is the syllabus' recommendation rule verbatim: `argmin(mastery)`
over unlocked nodes whose prerequisite concepts all exceed 0.7.

The review queue is a forgetting curve, not a fixed ladder: an item is due when
predicted recall `2^(-t/h)` falls to 90%, and `h` extends on every successful
review.

### Labs (`/labs`) — §5, §7, §10
`POST /submit` · `GET /submissions/:id` · `GET /submissions` · `GET /credits` ·
`POST /quote` · `POST /internal/:submissionId/result` (service token)

The credit debit, the submission row and the BullMQ enqueue happen in **one
transaction**, so a job can never run uncharged and a failed enqueue rolls the
charge back. The BullMQ job id *is* the submission id, so at-least-once delivery
cannot double-grade. Jobs that error or time out are refunded; a wrong answer is
not.

### Contests (`/contests`) — §6
`GET /` · `GET /:contest` · `POST /:contest/register` · `POST /:contest/virtual` ·
`GET /:contest/problems` · `GET /:contest/problems/:label` ·
`POST /:contest/submit` · `GET /:contest/submissions` · `GET /:contest/me` ·
`GET /:contest/standings` · `POST /:contest/freeze` · `POST /:contest/finalise` ·
`POST /:contest/verdict` (service token)

See [Contest correctness](#contest-correctness).

### Leaderboard (`/leaderboard`)
`GET /global` (XP) · `GET /ratings` (Glicko-2) · `GET /contests/:contestId` ·
`GET /institutions/:orgId` · `GET /me`

Global and institution boards are Redis sorted sets kept in step as XP is
awarded, so a page is a `ZREVRANGE`. They are a *cache* of the append-only
`progress.xp_events`, and a cold or flushed key is rebuilt from that ledger on
first read rather than returning an empty board. Ties share a rank, so two users
in the same state never appear to swap places.

### Billing (`/billing`) — §7
`GET /plans` · `/subscription` · `/credits` · `/invoices` · `POST /checkout` ·
`POST /portal` · `POST /webhook` · `POST /reconcile` · `GET /reconcile/runs`

No request path calls Stripe to decide anything: feature checks read
`billing.entitlements`, which is what makes §9 step 5 ("Stripe down →
entitlements keep working") true. Webhook idempotency is a unique index on
`stripe_event_id` — the insert *is* the lock, and a redelivery that loses it
returns 200 without reprocessing. Signature verification needs the exact bytes,
so `/webhook` lives in its own encapsulated scope with a buffer content-type
parser while every other route stays JSON-only.

The nightly reconciliation (`billing-ops` repeatable, 03:17 UTC) replays every
subscription against Stripe and repairs drift, recording each run in
`billing.reconciliation_runs`.

### Instructor (`/instructor`) — §7 (Teams and Campus)
`POST /join` (learner, join code) · `POST|GET /cohorts` · `GET /cohorts/:id` ·
`POST /cohorts/:id/members` · `DELETE /cohorts/:id/members/:userId` ·
`POST /cohorts/:id/assignments` · `PATCH /assignments/:id` ·
`PUT /assignments/:id/grades/:userId` · `GET /cohorts/:id/gradebook` ·
`GET /cohorts/:id/heatmap` · `GET /cohorts/:id/export.csv`

Gated twice — by the `instructor.dashboard` entitlement and by role, which also
forces the MFA §8 requires. The heatmap stores nothing of its own: it is a join
from cohort membership onto `progress.concept_mastery`, decayed to *now* by the
same forgetting curve the learner sees, so it can never disagree with the
learner's own view. Each gradebook cell carries the recorded score *and* the
score computed from lesson completion, so an override is visible as an override.

### Tutor (`/tutor`) — §7, §9, §12
`POST /messages` (SSE) · `GET /usage`

A streaming proxy with a budget. Four gates, in order:

1. **Integrity, not a budget:** `mode: "hint"` is hard-disabled while the caller
   is registered as a *rated live* participant in a *currently running rated*
   contest. It fails closed before anything else runs and returns
   `tutor-disabled-during-contest`.
2. Per-plan messages/day (§7) as a token bucket.
3. Per-user 50k tokens/day hard ceiling (§9).
4. Cell-wide hourly spend stop (§12) — above it the stream still runs but
   degrades to retrieval-only (§9 step 3) and says so in its `meta` event.

Usage is parsed out of the stream rather than trusted from a trailer, so a
client that disconnects early is still charged for what was produced.

### Admin (`/admin`)
`GET /users` · `PATCH /users/:userId` · `POST /contests` ·
`PATCH /contests/:contestId` · `POST /contests/:contestId/problems` ·
`GET|PUT|DELETE /degradation` · `GET /queues` · `POST /queues/repeatables` ·
`GET /stripe-events` · `GET /reconciliation` · `GET /reports` ·
`PATCH /reports/:reportId`

A role or status change bumps `privilege_version` and destroys every session the
user holds — §8's "rotated on privilege change", applied to revocation.
Creating a contest schedules its freeze and its finaliser immediately, so
neither depends on anyone remembering to run them.

---

## Contest correctness

§6 is the hardest correctness problem in the product, and the whole argument
fits in a paragraph:

- A score is only ever **incremented**, never recomputed, so the board is
  monotone by construction.
- The increment is guarded by `SETNX solved:{contest}:{user}:{problem}` inside
  the **same Lua script** as `ZINCRBY lb:{contest}`
  (`src/redis/scripts.ts` → `CONTEST_SCORE_LUA`). A `(user, problem)` pair can
  contribute at most once no matter how many graders deliver the same accept.
- Because the guard is idempotent, BullMQ's at-least-once delivery is safe.
- There is **no read-modify-write in application code**, so concurrent graders
  cannot interleave.
- Every key of one contest carries the `{contest}` hash tag, so all four keys
  live in one Redis Cluster slot and the script is legal on a cluster.

Scores are packed as `points * 2^32 - penalty_seconds` (§5): points dominate,
penalty breaks ties in favour of the faster solve, and both stay inside the
53-bit integer range of a ZSET double.

**Write path.** `POST /:contest/submit` validates entitlement, window,
registration, the 10/min bucket and the 20 s per-problem cooldown, runs the §6
anti-cheat checks (normalised-AST duplicate across users, submission within 4 s
of the problem opening), inserts one row into the monthly partition and enqueues
at contest priority. It returns 202. No locks, no waiting on a grader.

**Freeze.** At `T-60min` a scheduled job snapshots the board into
`contest.standings_snapshots`, sets `frozen:{contest}` and publishes a freeze
event. The broadcaster stops publishing; **the ZSET keeps updating**, which is
what makes the final board correct rather than merely late. `GET /standings`
serves the frozen snapshot to everyone but an admin passing `?live=true`.

**Finalisation.** At `T+0` the finaliser snapshots the ZSET into
`standings_snapshots` + `standings_rows`, then rates the contest as one Glicko-2
rating period: every live rated participant against every other, 1 for a better
rank, 0.5 for a tie, using **pre-contest** ratings so the result does not depend
on iteration order. Initial deviation 350 and a per-contest volatility cap, per
§6. Anyone with a flagged submission is excluded from ratings. Virtual
participants are excluded by construction — the schema forces `rated = false`
for them, because an elapsed time measured against a private start is not
comparable with the live field. Both operations are idempotent.

**Virtual participation** scores onto a separate board key
(`lb:{contest}:virtual`), so replaying a finished contest cannot move the
historical standings.

---

## Testing

```bash
pnpm test                 # everything
pnpm test:unit            # pure logic only
pnpm test:integration     # Postgres + Redis
```

`tests/global-setup.ts` probes Postgres and Redis. When they are reachable it
creates and migrates a dedicated `<database>_test` alongside the development one
and points the suites at Redis logical database 15, so a dev keyspace is never
flushed. When they are **not** reachable it does not fail the run: it prints a
line naming what is missing, and the affected suites skip themselves with their
own message. A skipped integration run is never silently mistaken for a passing
one.

| Suite | Needs | Covers |
|---|---|---|
| `unit/entitlements` | — | the §7 matrix cell by cell, `effectivePlan` across every subscription status, feature gates and their typed 403s |
| `unit/credits` | — | `ceil(2^(n-16)) * (shots/1024) * backend_multiplier` term by term, including that `ceil` binds to the exponential alone |
| `unit/glicko2` | — | Glickman's published worked example to 2 d.p., order-independence, the volatility cap, RD clamps |
| `unit/rate-limit` | Redis (bucket half only) | the §9 policy table as pure data, then the Lua token bucket under a 50-way burst, auth backoff, contest cooldown |
| `unit/dag` | — | unlock over a diamond, checkpoint gating, soft edges, cycle detection, `argmin(mastery)` recommendation |
| `integration/contest-scoring` | Redis | **200 simultaneous accepts for the same (user, problem)**, 200 distinct users at once, ICPC penalties, redelivery idempotence, key TTLs, slot tags |
| `integration/gateway` | Postgres + Redis | register → session → catalogue gating → DAG completion → review grading, `Idempotency-Key` replay and mismatch, entitlement denials, Stripe webhook idempotency, the tutor's contest lock-out |

The contest concurrency test is the one that matters. It fires 200 concurrent
`applyAccepted` calls for the same `(user, problem)` while a second task polls
the board throughout, and asserts that exactly one call scored, that the final
score is the single correct value, that every duplicate reported the same total,
and that the observer never saw the score decrease or take a partially-applied
value.

---

## Migrations

Schema lives in `src/db/schema/*.ts`; migrations are plain SQL in
`src/db/migrations` with a checked-in journal.

```bash
pnpm db:generate    # tsc, then drizzle-kit generate against dist/
pnpm db:migrate     # apply, then roll partitions forward
```

`db:generate` compiles first because `drizzle.config.ts` points at
`dist/src/db/schema/index.js`.

Three things are **hand-written and must be preserved on any regeneration**:

1. `PARTITION BY RANGE (created_at)` on `labs.submissions`,
   `contest.submissions` (monthly) and `progress.xp_events` (weekly). Drizzle's
   DSL cannot express declarative partitioning.
2. `0001_partitions.sql`: the partition lifecycle functions
   (`ops.ensure_partitions_ahead`, `ops.detach_partitions_older_than`), the
   append-only trigger on `billing.credit_ledger`, and the acyclicity triggers on
   `catalog.lesson_prereqs` and `catalog.concept_edges` — Postgres has no
   declarative way to say "this graph is a DAG".
3. The default catch-all partitions. A row that misses every range is a bug, but
   losing a submission because a partition was missing would violate the 99.999%
   durability SLO in §9, so it lands in the default and alerts.

`ops.ensure_partitions_ahead` also runs hourly from the `maintenance` queue and
at boot, so a write can never land on the default partition unexpectedly.

---

## Operations

**Graceful shutdown.** SIGTERM stops accepting connections, drains in-flight
requests up to `SHUTDOWN_GRACE_MS`, then closes the Postgres pools, the Redis
connections and the BullMQ producers — in that order. Closing them first would
turn a rolling deploy into a burst of 500s.

**Degradation ladder (§9).** `PUT /admin/degradation` stores a runtime override
in Redis; `.env` supplies the defaults. A Redis outage falls back to the
environment rather than to "everything on".

| Field | Effect |
|---|---|
| `simQueueOnly` | step 1 — server simulations are queued, not answered synchronously |
| `maxQubits` | step 2 — a temporary cap below every plan's ceiling; the denial names both |
| `tutorRetrievalOnly` | step 3 — the tutor answers from retrieval, labelled as such |
| `writesDisabled` | step 6 — writes return 503 with `Retry-After` during a primary failover |

**Observability (§11).** One span per request with W3C context propagated in and
out, 1% baseline sampling with force-sampling on errors, contest submissions and
payments. Prometheus exposes the four golden signals per route plus the domain
metrics §11 names as leading indicators: `sim_queue_depth`,
`sim_cache_events_total`, `grader_lag_seconds`, `contest_broadcast_lag_ms`,
`tutor_cost_usd_total`, `entitlement_denial_total`, `rate_limit_decisions_total`,
`credits_debited_total`, `contest_score_ops_total`. Logs are structured JSON with
`trace_id` on every line and no PII — IPs and user agents are stored only as
keyed digests.

---

## Configuration

Every variable is documented in [`.env.example`](./.env.example) and validated by
`src/env.ts` at boot; the process refuses to start on invalid configuration
rather than failing at the first request that needs it.

Only `DATABASE_URL` and `REDIS_URL` have no default. Production additionally
requires `SERVICE_JWT_PRIVATE_KEY` and `SERVICE_JWT_PUBLIC_KEY`, and you must
replace `CSRF_SECRET`, `PII_HASH_SECRET` and `MFA_ENCRYPTION_KEY` — their
defaults are development placeholders and are rejected by nothing but your own
review.

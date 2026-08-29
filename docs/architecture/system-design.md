# RedQuant System Design

Target: **50,000 concurrent users**, p99 < 300 ms on read paths, < 2 s for a
32-qubit statevector simulation, zero data loss on submissions, multi-AZ
survivability, and a contest path that stays correct when 50k people submit in
the same 90-second window.

---

## 1. Capacity model

Start from behaviour, not from vibes. 50k concurrent users decomposed by what
they are actually doing at any instant:

| Cohort | Share | Count | Action rate | Origin RPS | Notes |
|---|---|---|---|---|---|
| Reading lessons | 55% | 27,500 | 1 nav / 45 s | 611 | 95%+ CDN-cacheable |
| Editing circuits | 22% | 11,000 | 1 sim / 8 s | 1,375 | Most served by the **client-side** simulator |
| Running labs | 12% | 6,000 | 1 submit / 120 s | 50 | Sandboxed execution, async |
| In a contest | 8% | 4,000 | 1 submit / 90 s | 44 | Bursts to ~1,300 rps at deadline |
| Dashboards / social | 3% | 1,500 | 1 req / 20 s | 75 | Cache + ETag |

**Derived budgets**

- Edge: ~10,000 rps peak. Origin after CDN: **~1,500 rps steady, 3,500 rps peak.**
- WebSocket: 32,000 concurrent sockets (contest + collaborative lab presence).
- Simulation: 1,375 nominal sim/s, of which **≥ 92% never leaves the browser**
  (see §4). Server-side sims: **~110/s steady, 400/s peak.**
- Sandbox executions: 50/s steady, 250/s at contest deadline.
- Postgres: ~9,000 QPS read (85% from replicas + cache), ~450 QPS write.
- Redis: ~28,000 ops/s (leaderboards, rate limits, sessions, sim cache).

**Fleet sizing** (c7g.2xlarge-class, 8 vCPU / 16 GiB):

| Tier | Steady | Peak (HPA max) | Sizing basis |
|---|---|---|---|
| Web (Next.js SSR/RSC) | 12 | 40 | 180 rps/pod at 60% CPU |
| API gateway (Fastify) | 16 | 60 | 400 rps/pod; 10k WS/pod |
| Quantum kernel (FastAPI) | 24 | 120 | 6 workers/pod, 3 sim/s/worker |
| Sandbox runners | 20 | 100 | 2 concurrent jails/pod, 4 s median |
| Grader workers | 8 | 40 | queue-depth driven (KEDA) |
| AI tutor gateway | 6 | 24 | I/O bound, 80 in-flight/pod |

Headroom rule: every tier is provisioned so that **losing one entire AZ (33%)
still leaves 40% CPU headroom at steady state.**

---

## 2. Topology

```
                        ┌──────────── Cloudflare / CDN ────────────┐
                        │  static, MDX HTML, images, WASM sim       │
                        │  WAF, bot mgmt, 95% offload               │
                        └──────────────────┬───────────────────────┘
                                           │ anycast
                     ┌─────────────────────▼─────────────────────┐
                     │        L7 ALB  (per-region, 3 AZ)          │
                     └──┬──────────────┬──────────────┬───────────┘
                        │              │              │
              ┌─────────▼───┐   ┌──────▼──────┐  ┌────▼─────────┐
              │  web (SSR)  │   │ api-gateway │  │  ws-gateway  │
              │  Next.js    │   │  Fastify    │  │  Fastify+uWS │
              └─────────────┘   └──┬───┬───┬──┘  └────┬─────────┘
                                   │   │   │          │ Redis pub/sub
        ┌──────────────────────────┘   │   └──────────┴──────────┐
        │                              │                          │
┌───────▼────────┐        ┌────────────▼──────────┐   ┌───────────▼────────┐
│ quantum-kernel │        │  Postgres 18 primary  │   │  Redis Cluster     │
│  FastAPI       │        │  + 3 read replicas    │   │  6 shards, AZ-aware│
│  Aer/Cirq/PL   │        │  via PgBouncer        │   │  leaderboard/cache │
└───────┬────────┘        └───────────────────────┘   └────────────────────┘
        │
┌───────▼─────────┐   ┌──────────────────┐   ┌─────────────────────────┐
│ sandbox-runner  │   │ grader workers   │   │ ai-tutor gateway        │
│ gVisor jail     │   │ BullMQ consumers │   │ Claude API + RAG        │
└─────────────────┘   └──────────────────┘   └─────────────────────────┘
        │                       │                        │
        └───────────────┬───────┴────────────────────────┘
                        │
                ┌───────▼────────┐   ┌──────────────┐   ┌──────────────┐
                │ S3 / R2        │   │ ClickHouse   │   │ OTel → Tempo │
                │ artefacts      │   │ analytics    │   │ Prom + Loki  │
                └────────────────┘   └──────────────┘   └──────────────┘
```

### Cell-based deployment
Users are sharded into **cells** of ~12,500 concurrent users by
`hash(user_id) % N`. A cell is a full vertical slice: web, api, kernel, runners,
and a Redis shard group. Postgres stays regionally shared (one primary +
replicas) because cross-cell reads matter for global leaderboards; everything
latency- or blast-radius-sensitive is cell-local. Consequences:

- A bad deploy is contained to one cell (12.5k users, not 50k).
- Contest write bursts are absorbed per cell, then merged (see §6).
- Cells are the unit of canary. Rollout order: cell 0 (internal) → 1 → rest.

---

## 3. Services and their contracts

| Service | Language | Owns | Never does |
|---|---|---|---|
| `web` | TS / Next.js 15 RSC | Rendering, MDX, client sim, 3D instruments | Direct DB access |
| `api-gateway` | TS / Fastify | Auth, entitlements, CRUD, rate limits, job enqueue | Heavy compute |
| `ws-gateway` | TS / Fastify + uWebSockets | Contest clock, leaderboard deltas, presence | Persistence |
| `quantum-kernel` | Python / FastAPI | Simulation, transpile, noise, metrics, visual payloads | Auth, billing |
| `sandbox-runner` | Python + gVisor | Executing untrusted learner code | Network egress |
| `grader` | Python worker | Test harness, scoring, resource-bound checks | User-facing latency |
| `ai-tutor` | TS worker | Prompt assembly, RAG, streaming, cost control | Storing PII in prompts |

All inter-service calls are typed. TS↔TS via shared Zod schemas in
`packages/shared`; TS↔Python via an OpenAPI contract generated from FastAPI and
checked into `packages/shared/kernel-openapi.json` with a CI drift test.

---

## 4. The simulation tier: the single most important design decision

Naively, 1,375 simulations/second at 20-50 ms each needs ~50 dedicated cores of
pure numerics, and every one of those requests is a round trip that makes circuit
editing feel dead. The fix is a three-tier split keyed on **qubit count**:

| Tier | Where | Range | Latency | Share of traffic |
|---|---|---|---|---|
| **T-A** Client statevector | Browser, TypeScript (`@redquant/qir`) | ≤ 14 qubits | < 8 ms, no network | ~92% |
| **T-B** Server statevector | `quantum-kernel`, NumPy | 15-30 qubits | 40-900 ms | ~7.5% |
| **T-C** Heavy / tensor-network / noisy | `quantum-kernel` async queue | 31-40 qubits, or noisy density-matrix | 1-60 s | ~0.5% |

Editing a circuit is T-A: every keystroke re-simulates locally, so the Bloch
sphere and probability bars move at frame rate. T-B is a synchronous POST with a
900 ms budget. T-C returns a job id and streams over WebSocket.

**Result cache.** Every simulation request is keyed by
`sha256(canonical_ir || backend || shots || noise_model || seed)`. Canonicalisation
sorts commuting gates within a layer, so semantically identical circuits collide
intentionally. Measured hit rate on lesson traffic: high, because thousands of
learners run the *same* lesson circuit. Cache in Redis (24 h TTL, 1 KB-256 KB
values, LRU) fronted by an in-process LRU on each kernel pod.

**Memory guard.** A statevector of n qubits is `2^n * 16` bytes.
n=30 → 16 GiB. Hard limits per plan tier (§7) and an admission controller that
rejects before allocating, never during. Density-matrix simulation is capped at
n=14 (4 GiB).

---

## 5. Data model and storage

Postgres 18, one logical database, schema-per-domain.

| Schema | Key tables | Growth |
|---|---|---|
| `identity` | users, accounts, sessions, orgs, org_members, invites, api_keys | linear in users |
| `catalog` | tracks, modules, lessons, concepts, concept_edges, questions, companies | small, read-mostly, fully cached |
| `progress` | enrollments, lesson_state, mastery, review_queue, streaks, xp_events | ~40 rows/user/week |
| `labs` | submissions, submission_results, artefacts | highest write volume |
| `contest` | contests, problems, registrations, submissions, standings_snapshots, ratings | bursty |
| `billing` | plans, subscriptions, entitlements, credit_ledger, invoices | linear |
| `social` | discussions, comments, votes, reports | moderate |

**Partitioning.** `labs.submissions` and `contest.submissions` are range-partitioned
monthly; `progress.xp_events` weekly. Old partitions are detached to S3 Parquet
after 13 months and remain queryable through ClickHouse.

**Hot-path denormalisation.** `progress.mastery` carries a materialised
`unlocked_lesson_ids int[]` so the "what can I do next" query is a single row read
instead of a DAG traversal. It is recomputed transactionally whenever a lesson
completes.

**Read/write split.** Writes to primary via PgBouncer (transaction pooling,
1,200 client conns → 120 server conns). Reads to replicas, except reads inside a
write transaction and reads within 500 ms of a user's own write (tracked by a
per-user `write_lsn` in Redis, so the user always sees their own action).

**Redis usage** (6-shard cluster, `cluster-enabled`, AOF everysec):
- `lb:{contest_id}` — sorted set, member = user, score = packed `(points<<32) | (2^32 - penalty_seconds)`. O(log N) update, O(1) rank read.
- `sim:{hash}` — simulation cache.
- `rl:{bucket}` — token buckets (§9).
- `sess:{sid}` — sessions, 14 d TTL, sliding.
- `presence:{lesson_id}` — HyperLogLog of concurrent viewers.
- Pub/sub channels `ws:contest:{id}`, `ws:user:{id}` for fanout.

---

## 6. Contests: the hardest correctness problem in the product

Requirements: a 90-second submission burst from 4,000-50,000 users, exact
scoring, a leaderboard that is *monotone* (never shows a rank going backwards
for the same state), and a frozen final standing.

**Write path**

1. `POST /contests/:id/submit` → API validates entitlement + rate limit, writes
   the submission row (partitioned table, single INSERT, no locks), enqueues to
   BullMQ `grade` queue with `priority = contest`. Returns 202 + submission id.
   Budget: 12 ms.
2. Grader workers (KEDA-scaled on queue depth) pull, execute in a sandbox, and
   write `submission_results`.
3. On accept, the worker runs a **Lua script** on Redis that atomically: checks
   the first-accept marker `SETNX solved:{contest}:{user}:{problem}`, and only if
   it wins, does `ZINCRBY lb:{contest} points` and records penalty. Idempotent
   under retries, which is what makes at-least-once delivery safe.
4. A leaderboard-broadcaster reads deltas and publishes to `ws:contest:{id}`.
   Clients receive *deltas*, plus a full snapshot every 30 s to self-heal.

**Why this is monotone.** Score is only ever incremented, and only once per
(user, problem), guarded by SETNX inside the same Lua script as the ZINCRBY. There
is no read-modify-write from application code, so concurrent graders cannot
interleave.

**Freeze and finalisation.** At `T-60min` the public board freezes (broadcaster
stops publishing; the Redis ZSET keeps updating). At `T+0` a finaliser job
snapshots the ZSET into `contest.standings_snapshots`, recomputes ratings, and
publishes the final board. Ratings use **Glicko-2** with a 350 initial deviation
and a per-contest volatility cap, computed in one batch job.

**Anti-cheat.** Per-submission: exact-duplicate detection across users
(normalised AST hash of submitted code), timing analysis (submission within 4 s
of problem open), IP/device clustering, and a shadow-scored rerun of the top 100
against an extended hidden test set before ratings publish.

---

## 7. Plans, entitlements and credits

Entitlements are a pure function of subscription state, evaluated at the gateway
and cached in the session. No feature check ever hits Stripe.

| | Free | Pro ($19/mo) | Teams ($39/seat) | Campus (annual) |
|---|---|---|---|---|
| Lessons | T0-T1 | all | all | all |
| Labs / month | 40 | unlimited | unlimited | unlimited |
| Max qubits (statevector) | 16 | 28 | 30 | 32 |
| Noisy simulation | no | yes, ≤ 12 q | yes, ≤ 14 q | yes, ≤ 14 q |
| Sim credits / month | 500 | 20,000 | 50,000/seat | negotiated |
| AI tutor messages / day | 15 | 300 | 300 | 300 |
| Contests | participate | participate + rated + editorials | + private contests | + private contests |
| Interview bank | 20 questions | full 240 | full | full |
| Instructor dashboard | no | no | yes | yes |
| SSO | Google/GitHub | + Microsoft, ORCID | + SAML | + SAML, SCIM |
| Certificates | no | yes | yes | yes, co-branded |

**Credits.** One credit = one server-side simulation unit, priced as
`ceil(2^(n-16)) * (shots/1024) * backend_multiplier`. A T-A client simulation
costs nothing, which is why the client-side engine is a business decision as much
as a latency one. The ledger is append-only (`billing.credit_ledger`) with a
materialised balance; debits happen in the same transaction as job enqueue, so a
job can never run uncharged.

**Stripe.** Checkout + Customer Portal. Webhooks are idempotent
(`stripe_event_id` unique index), signature-verified, and processed
out-of-band; the entitlement table is the source of truth and is reconciled by a
nightly job that replays Stripe state.

---

## 8. Identity and SSO

- **OIDC**: Google, Microsoft Entra, GitHub, ORCID (researchers), LinkedIn.
- **SAML 2.0** for institutions, one connection per org, with IdP-initiated and
  SP-initiated flows; **SCIM 2.0** for user provisioning on Campus.
- **Passkeys** (WebAuthn) and email magic links. Passwords are Argon2id
  (m=64 MiB, t=3, p=4) and exist only for legacy import.
- Sessions: opaque 256-bit id in an `HttpOnly; Secure; SameSite=Lax` cookie,
  Redis-backed, sliding 14 d, rotated on privilege change. Access to internal
  services uses short-lived (5 min) EdDSA-signed JWTs minted by the gateway.
- **Org resolution**: email-domain claim (verified by DNS TXT) auto-routes a
  learner to their institution's SSO and seat pool.
- MFA required for `instructor` and `org_admin`.

---

## 9. Reliability, limits and failure behaviour

**Rate limits** (token bucket in Redis, Lua, per-user and per-IP, with a
per-cell circuit breaker):

| Endpoint class | Limit |
|---|---|
| Read | 120 / 10 s |
| Server simulation | 30 / min (Free), 240 / min (Pro) |
| Lab submission | 6 / min |
| Contest submission | 10 / min, plus 20 s per-problem cooldown |
| AI tutor | plan-based, plus a 50k token/day hard ceiling |
| Auth | 10 / 10 min / IP, exponential backoff on failure |

**Graceful degradation ladder.** Each step sheds load without lying to the user:

1. Kernel saturated → T-B requests get `202 + queued` instead of synchronous, UI
   shows a queue position.
2. Kernel still saturated → server sims restricted to ≤ 22 qubits; the UI states
   the temporary cap.
3. AI tutor over budget → falls back to retrieval-only answers with citations,
   labelled as such.
4. ClickHouse down → analytics pages show "delayed", core learning unaffected.
5. Stripe down → entitlements keep working from the cached table; new purchases
   queue.
6. Postgres primary failover (~30 s) → reads continue from replicas, writes
   return `503` with `Retry-After`, and the client retries idempotently using a
   client-generated `Idempotency-Key`.

**SLOs.** Read availability 99.95%. Submission durability 99.999% (accepted =
committed). Contest scoring correctness: 100%, verified by a post-contest replay
that recomputes standings from the submission log and diffs against the snapshot.

**Idempotency.** Every mutating endpoint accepts `Idempotency-Key`; the gateway
stores `(key, user, response)` in Redis for 24 h.

---

## 10. Sandbox: executing untrusted quantum code

Threat model: arbitrary Python from anonymous users, some of it hostile.

- **Isolation**: gVisor (`runsc`) sandbox, one process per submission, read-only
  root filesystem, `tmpfs` scratch of 64 MiB.
- **No network.** Empty network namespace. Not a firewall rule, an absent
  interface.
- **Limits**: 2 s CPU (10 s for projects), 512 MiB RSS, 64 processes, 4 MiB
  stdout, wall-clock kill at 3× CPU limit.
- **Syscall surface** reduced by seccomp to the ~60 calls CPython + NumPy need.
- **Imports** restricted to an allowlist (`numpy`, `qiskit`, `cirq`,
  `pennylane`, `scipy`, `math`, `itertools`, `typing`); the loader denies
  everything else, including `os`, `sys`, `subprocess`, `socket`, `ctypes`.
- **Determinism**: seeded RNG, frozen wall clock, so hidden tests are reproducible.
- Runners are **single-use**: the pod is recycled after N=50 executions.

---

## 11. Observability

- **Traces**: OpenTelemetry end to end, one trace per user action, sampled at
  1% baseline and 100% for errors, contest submissions, and payments.
- **Metrics** (Prometheus): the four golden signals per service, plus domain
  metrics that predict incidents: `sim_queue_depth`, `sim_cache_hit_ratio`,
  `grader_lag_seconds`, `contest_broadcast_lag_ms`, `tutor_cost_usd_per_hour`,
  `entitlement_denial_rate`.
- **Logs**: structured JSON, Loki, no PII, `trace_id` on every line.
- **RUM**: Core Web Vitals per route, plus `time_to_first_amplitude` — our own
  metric for how long until a learner sees their circuit's state. Budget: 120 ms.
- **Dashboards**: one per user journey (read a lesson, run a lab, join a
  contest), not one per service. Alerts fire on SLO burn rate, never on raw CPU.

## 12. Cost envelope

At 50k concurrent / ~1.2M MAU, steady state:

| Line | Monthly |
|---|---|
| Compute (web, api, ws, kernel, runners, graders) | $18-24k |
| Postgres (primary + 3 replicas, 4 TB) | $4.5k |
| Redis cluster (6 shards, 48 GiB) | $2.1k |
| CDN + egress | $3.2k |
| ClickHouse + object storage | $1.8k |
| AI tutor inference | $9-16k (governed by the per-plan ceilings in §7) |
| Observability | $2.4k |
| **Total** | **$41-54k** |

The AI line is the one that can run away, which is why the tutor gateway enforces
a hard per-hour spend ceiling with an automatic downgrade to retrieval-only.

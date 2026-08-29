---
title: RedQuant On-Call Master Index
severity_range: SEV1-SEV4 (this document governs all)
owning_team: Platform SRE
page_policy: n/a — reference document, not a page target
expected_time_to_mitigate: n/a — index document
last_reviewed: 2026-08-29
---

# RedQuant On-Call Runbook Index

This is the entry point for anyone holding the RedQuant pager. It defines
severities, escalation, comms, incident-command roles, the first-five-minutes
checklist, and links every other runbook. If you only read one document before
your shift, read this one. All section references (`§n`) are to
`docs/architecture/system-design.md`, the authoritative system spec.

---

## 1. Severity definitions

Severities are tied directly to the three §9 SLOs:

- **Read availability: 99.95%** over a rolling 28-day window.
- **Submission durability: 99.999%** (an accepted submission — `202` returned
  — must be committed; losing one is a durability violation).
- **Contest scoring correctness: 100%**, verified by the post-contest replay
  (see [contest-day.md](contest-day.md)). There is **no error budget** for this
  SLO — any non-zero incorrect-scoring event is automatically SEV1.

### SEV1 — critical, all-hands, page immediately

Definition: an SLO is actively breached or about to be irrecoverably breached,
or the breach is unbounded without intervention.

Concrete examples from this product:
- Postgres primary is down and CNPG failover has not completed within the
  ~30s budget from §9 step 6. The write path is fully down and submission
  durability (99.999%) is at risk for every in-flight write.
- A post-contest replay (§9, see [contest-day.md](contest-day.md)) produces a
  **non-empty diff** between recomputed standings and the published
  `contest.standings_snapshots` row. Scoring correctness is a 100% SLO with
  zero error budget — this is SEV1 regardless of how small the diff is or how
  few users are affected.
- A multi-window multi-burn-rate alert fires on the **fast (1h) window** for
  the read-availability SLO at the fast-burn threshold — the trajectory
  implies the entire 28-day error budget is exhausted in under a day.
- A confirmed or credibly suspected sandbox escape (§10) — see
  [sandbox-escape-suspected.md](sandbox-escape-suspected.md). Always SEV1,
  no exceptions, regardless of confirmed blast radius, because the threat
  model assumes hostile arbitrary code from anonymous users.
- The AI tutor's automatic cost-downgrade safety mechanism (§9 step 3) fails
  to engage while `tutor_cost_usd_per_hour` continues climbing past the
  configured ceiling with no sign of self-correction — see
  [ai-tutor-cost-runaway.md](ai-tutor-cost-runaway.md).
- `sim:{hash}` or leaderboard (`lb:{contest_id}`) keys are being evicted by
  Redis during an **active contest** — a direct contest-correctness risk, see
  [redis-cluster-incident.md](redis-cluster-incident.md).

### SEV2 — major, page during the incident, on-call + secondary handle

Definition: significant, bounded degradation of one SLO-relevant path, or a
cell-scoped (not global) outage, or a safety mechanism working as designed
but not yet resolving root cause.

Concrete examples:
- One cell (12,500 users, §2) is degraded or down due to a bad canary deploy.
  The blast radius is contained to that cell by design — this is the entire
  point of cell-based deployment (§2) — but it is still a real, paged
  incident for those 12,500 users.
- `DEGRADE_TUTOR_RETRIEVAL_ONLY` has auto-engaged correctly (§9 step 3) and is
  holding cost under the ceiling, but the underlying cause (abuse,
  prompt-assembly bug, retry storm) is still unidentified after 30 minutes.
- A single Redis shard has failed but cluster slot coverage is intact via its
  replica — degraded redundancy, not yet a correctness or availability
  problem, but one more failure away from one.
- A Postgres replica is lagging significantly, degrading read freshness for
  some users, without yet threatening the write path or the read-availability
  SLO outright.

### SEV3 — moderate, business-hours page, ticket during off-hours unless trending up

Definition: a real problem, currently contained by a design safeguard (cache,
degradation ladder, redundancy), with no near-term SLO risk.

Concrete examples:
- Stripe webhook backlog is building, but entitlements remain correct because
  they're served from the cached `billing.entitlements` table (§9 step 5) —
  see [stripe-webhook-backlog.md](stripe-webhook-backlog.md).
- `grader_lag_seconds` is elevated but nowhere near breaching the submission
  durability SLO (submissions are still being accepted and durably written;
  they're just graded slower than usual).
- `sim_queue_depth` is elevated and step 1 of the degradation ladder
  (`DEGRADE_SIM_ASYNC`) has engaged as designed — see
  [simulation-saturation.md](simulation-saturation.md).

### SEV4 — minor, ticket only, never pages

Definition: transient, self-resolved, or non-production.

Concrete examples:
- A single pod hit a restart loop and recovered on its own within its
  liveness-probe budget.
- An alert fired in `redquant-staging` or `redquant-dev`.
- A `sess:{sid}` eviction affecting a handful of users (forced re-login, no
  data loss, no correctness impact) — see
  [redis-cluster-incident.md](redis-cluster-incident.md).

---

## 2. Escalation ladder

| Role | Trigger | Time box |
|---|---|---|
| Primary on-call SRE | Page fires | Ack within 5 min |
| Secondary/backup SRE | No ack from primary | Paged automatically at 10 min |
| Incident Commander (IC) | Any SEV1/SEV2 | Designated within 15 min of declare |
| Domain expert | Per affected runbook (below) | Paged by IC as soon as the affected system is identified |
| Engineering Director | SEV1 unresolved | Paged at 30 min |
| VP Eng / exec comms | SEV1 unresolved, or any confirmed sandbox escape (§10) | Paged at 60 min, or immediately for a confirmed escape regardless of elapsed time |

Domain experts by runbook:
- Payments/Billing eng — [stripe-webhook-backlog.md](stripe-webhook-backlog.md)
- Quantum Kernel eng — [simulation-saturation.md](simulation-saturation.md), [contest-day.md](contest-day.md)
- AI/ML eng — [ai-tutor-cost-runaway.md](ai-tutor-cost-runaway.md)
- Database Reliability Eng (DBRE) — [postgres-failover.md](postgres-failover.md)
- Data/Cache eng — [redis-cluster-incident.md](redis-cluster-incident.md)
- Security/AppSec (always joint with SRE, always paged) — [sandbox-escape-suspected.md](sandbox-escape-suspected.md)

## 3. Paging policy and business hours

- **SEV1 / SEV2**: page 24/7 via the paging system, no exceptions, no
  quiet hours.
- **SEV3**: pages during business hours only (Mon-Fri, 08:00-20:00, primary
  on-call's local time zone). Outside business hours, SEV3 becomes a ticket
  for the next business day **unless** it is trending toward SEV2 — e.g.
  `entitlement_denial_rate` still climbing two hours after first detected —
  in which case escalate to a page regardless of hour.
- **SEV4**: never pages. Ticket only, triaged at the next standup.

## 4. Error-budget policy

The read-availability (99.95%) and submission-durability (99.999%) SLOs each
carry a 28-day rolling error budget per §9. When a budget is **fully spent**
within the window:

1. **Deploy freeze** on the affected service(s) or cell(s) until the budget
   recovers above a 10% remaining threshold.
2. **Second-approver requirement**: any deploy touching the affected path
   during the freeze requires sign-off from a Staff+ engineer in addition to
   the author.
3. **Mandatory retro** before the freeze is lifted early. A freeze may only be
   lifted ahead of natural budget recovery with IC + Eng Director sign-off
   after the retro identifies and mitigates the root cause.

**Contest scoring correctness has no error budget.** It is a 100% SLO per §9.
Any non-zero incorrect-scoring event detected by the post-contest replay is
SEV1 by definition — see [contest-day.md](contest-day.md) — with no
"budget spent" gray zone. There is no such thing as an acceptable amount of
wrong scoring.

## 5. Comms templates

Use `{{double-brace}}` placeholders as literal template variables — fill them
in when you use the template, do not leave the braces in a real message.

### SEV1

**Initial ack** (post within 5 min of declare, to the incident channel):
```
[SEV1] {{service}} — investigating
Impact: {{impact_description}}
Started: {{start_time}}
IC: {{ic_name}} | Ops: {{ops_name}} | Comms: {{comms_name}} | Scribe: {{scribe_name}}
Next update in 15 min.
```

**30-min update**:
```
[SEV1] {{service}} — update, {{elapsed_time}} elapsed
Status: {{current_status}}
Actions taken: {{actions_taken}}
Current hypothesis: {{hypothesis}}
ETA: {{eta}}
Next update in 15 min.
```

**Resolution**:
```
[SEV1] {{service}} — RESOLVED
Duration: {{start_time}} - {{end_time}} ({{duration}})
Root cause: {{root_cause}}
Impact: {{impact_description}}
Follow-up tracked: {{followup_ticket}}
Retro scheduled: {{retro_date}}
```

**Customer-facing status page** (SEV1 — requires IC + Comms sign-off before
posting):
```
{{status_icon}} Major incident: {{public_impact_description}}
We are aware of an issue affecting {{affected_capability}} and are actively
working on it. Next update by {{next_update_time}}.
```

### SEV2

**Initial ack**:
```
[SEV2] {{service}} — investigating
Impact: {{impact_description}} (scope: {{affected_scope}})
IC: {{ic_name}}
Next update in 30 min.
```

**30-min update**: same shape as SEV1, cadence 30 min instead of 15.

**Resolution**: same shape as SEV1.

**Customer-facing status page** (only if user-visible — many SEV2s, like a
single-cell degradation, may not warrant one):
```
{{status_icon}} Degraded performance: {{public_impact_description}}
Some users may experience {{symptom_description}}. We are working on it.
```

### SEV3

**Initial ack** (incident channel or ticket, business hours):
```
[SEV3] {{service}} — {{issue_summary}}
Contained by: {{safeguard_description}}
Owner: {{owner_name}}
```

**Update**: post only if status changes materially; no fixed cadence
required.

**Resolution**:
```
[SEV3] {{service}} — resolved
Root cause: {{root_cause}}
Follow-up: {{followup_ticket}}
```

**Customer-facing status page**: generally not needed. If a subset of users
is visibly affected (e.g. a payment confirmation delay), use:
```
{{status_icon}} Minor issue: {{public_impact_description}} — no action needed,
resolving automatically.
```

### SEV4

No comms templates — ticket only, no channel post, no status page.

---

## 6. Incident-command roles

- **IC (Incident Commander)** — owns decisions, declares/adjusts severity,
  runs the bridge, is the single point of authority for the incident's
  duration. Does not necessarily run commands themselves.
- **Comms** — owns the status page and stakeholder updates, drafts from the
  templates above, keeps update cadence.
- **Ops** — hands-on-keyboard, runs the procedures from the relevant
  runbook(s).
- **Scribe** — maintains the incident timeline in the incident channel/doc,
  timestamps every material action and decision (this is what post-incident
  review is built from — see §9 below).

For **SEV3/SEV4**, one person may hold multiple roles (commonly the on-call
engineer holds all four). For **SEV1/SEV2**, these must be distinct people —
the person running commands should not also be the one deciding whether to
escalate or what to tell customers.

---

## 7. First five minutes

Run this literally, in order, the moment you acknowledge a page:

1. **Ack the page** in the paging system.
2. **Declare the incident** in the incident-management tool (or, at minimum,
   open a dedicated incident channel and post the SEV1/SEV2/SEV3 ack template
   from §5 above).
3. **Open the relevant Grafana dashboard(s)** to scope blast radius — per
   §11, dashboards are per user journey, not per service:
   - `journey-read-a-lesson`
   - `journey-run-a-lab`
   - `journey-join-a-contest`
   Check which journey(s) show anomalies; this tells you which runbook to
   open next.
4. **Identify affected cell(s)**, if any. Postgres is regionally shared, but
   web/api/kernel/sandbox/Redis-shard-groups are cell-local (§2):
   ```
   for i in 0 1 2 3; do
     echo "=== cell-$i ==="
     kubectl get pods -n redquant-cell-$i --field-selector=status.phase!=Running
   done
   ```
   Also check the shared `redquant-prod` namespace (Postgres, shared Redis
   cluster, ai-tutor if not cell-scoped):
   ```
   kubectl get pods -n redquant-prod --field-selector=status.phase!=Running
   ```
5. **Determine severity** using §1 above. When uncertain between two
   severities, declare the higher one — you can always downgrade once you
   have more information; you cannot un-page people if you waited too long.
6. **Page IC and secondary** if SEV1/SEV2 and they are not already engaged.
7. **Open the specific runbook** for the affected system from the list in §8
   below and follow its Symptoms → Dashboards → Decision tree → Procedures
   flow.
8. **Start the scribe timeline** — first entry should be "page acked at
   {{time}}", every subsequent command run or decision made gets its own
   timestamped line.

The same flow, as a flowchart:

```mermaid
flowchart TD
    A[Page fires] --> B[Ack in paging system\nwithin 5 min]
    B --> C[Declare incident /\nopen #incident-YYYYMMDD-N channel]
    C --> D[Open journey dashboards:\njourney-read-a-lesson\njourney-run-a-lab\njourney-join-a-contest]
    D --> E{Which journey(s)\nshow anomalies?}
    E -->|read a lesson| F1[Suspect: web, CDN,\nPostgres replicas, Redis cache]
    E -->|run a lab| F2[Suspect: sandbox-runner,\ngrader, kernel, Postgres]
    E -->|join a contest| F3[Suspect: contest path,\nRedis leaderboard, broadcaster]
    F1 --> G[Check cell health loop\ncells 0-3 + redquant-prod]
    F2 --> G
    F3 --> G
    G --> H{Severity per §1?\nWhen unsure, pick higher}
    H -->|SEV1 or SEV2| I[Page IC + secondary\nif not already engaged]
    H -->|SEV3| J[Business-hours page\nor next-business-day ticket]
    H -->|SEV4| K[Ticket only, no page]
    I --> L[Open the specific runbook\nfor the affected system]
    J --> L
    K --> L
    L --> M[Start scribe timeline:\nfirst line = page acked at {{time}}]
```

---

## 8. Runbook index

| Runbook | Use this when |
|---|---|
| [contest-day.md](contest-day.md) | Any contest is upcoming (T-7d checklist) or currently running — pre-flight, freeze, finalisation, anti-cheat, post-contest replay. |
| [simulation-saturation.md](simulation-saturation.md) | `sim_queue_depth` is elevated, circuit editing feels laggy, kernel CPU is pinned, or server-side sim volume looks abnormally high (possible client-simulator failure). |
| [postgres-failover.md](postgres-failover.md) | Postgres primary is down, replication lag is high, PgBouncer pools are saturated, or writes are returning 503. |
| [redis-cluster-incident.md](redis-cluster-incident.md) | Redis cluster slot coverage is lost, a shard is down, memory pressure is evicting keys that must not be evicted (leaderboards), or sessions/rate-limits are behaving oddly. |
| [sandbox-escape-suspected.md](sandbox-escape-suspected.md) | Any signal that untrusted submitted code may have broken out of its gVisor sandbox — outbound network activity, unexpected syscalls, filesystem writes outside scratch. Always SEV1. Containment first, forensics second. |
| [stripe-webhook-backlog.md](stripe-webhook-backlog.md) | Stripe webhook queue depth is climbing, `entitlement_denial_rate` is rising, or a customer reports paying but not receiving their plan features. |
| [ai-tutor-cost-runaway.md](ai-tutor-cost-runaway.md) | `tutor_cost_usd_per_hour` is alerting, or the AI tutor's automatic retrieval-only downgrade has engaged (or should have and didn't). |

Keep this table in sync if a new runbook is added — every runbook must be
reachable from here.

---
title: AI Tutor Cost Runaway Runbook
severity_range: SEV2 (auto-downgrade engaged, cost trending toward ceiling) to SEV1 (safety mechanism failed to engage, spend climbing uncontrolled)
owning_team: Platform SRE + AI/ML eng + Finance/Cost-eng liaison
page_policy: page for SEV2+; SEV1 pages immediately
expected_time_to_mitigate: minutes to confirm/engage downgrade; longer to resolve root cause
last_reviewed: 2026-08-29
---

# AI Tutor Cost Runaway Runbook

Covers §7 (plans/entitlements/credits — AI tutor message limits), §12 (cost
envelope), and §9 step 3 (degradation ladder) of system-design.md. See also:
[oncall.md](oncall.md) for severity/escalation,
[simulation-saturation.md](simulation-saturation.md) (degradation-ladder
sibling step), [stripe-webhook-backlog.md](stripe-webhook-backlog.md)
(entitlement/plan-ceiling overlap), [postgres-failover.md](postgres-failover.md),
[redis-cluster-incident.md](redis-cluster-incident.md),
[contest-day.md](contest-day.md),
[sandbox-escape-suspected.md](sandbox-escape-suspected.md).

Infra: `ai-tutor` is a TS worker (`apps/api` tutor entrypoint, port 3002,
metrics on 9464), deployed as `ai-tutor` in `redquant-prod` and each
`redquant-cell-0..3`. §11 domain metric `tutor_cost_usd_per_hour` is the
alert metric.

Plan ceilings (§7): AI tutor messages/day — Free 15, Pro/Teams/Campus 300 —
plus a **50k token/day hard ceiling per user** across all plans (§9 rate
limits table). §12: the AI tutor inference line is **$9-16k/month**, called
out explicitly as "the one that can run away," which is why the tutor
gateway enforces a hard per-hour spend ceiling with automatic downgrade to
retrieval-only.

---

## 1. Symptoms

Exact alert names: `TutorCostPerHourHigh` on `tutor_cost_usd_per_hour`,
`TutorCostCeilingBreached`, `TutorTokenCeilingApproaching` (on the 50k/day
hard ceiling, §9).

User reports: "the tutor gave a shallow/generic answer" (expected during a
correctly-labelled retrieval-only degrade per §9 — verify it's labelled as
such before assuming this is a problem), "the tutor stopped responding".

Graph shapes: cost-per-hour climbing steeply; per-user token consumption
spiking abnormally for a small set of users (abuse signature); request
volume flat but cost climbing (per-request cost inflation — a
prompt-assembly bug signature).

---

## 2. Dashboards to open

There is no single named §11 journey dashboard dedicated to tutor cost —
it's a cross-cutting cost concern rather than one user journey, though
learner-facing tutor usage is visible inside `journey-read-a-lesson`. Use a
tutor-cost dashboard with panels for: cost/hour trend, top-N token
consumption per user, request volume vs cost correlation (to distinguish
"more legitimate usage" from "cost per request exploding"), and retry rate.

Exact PromQL:

```promql
# Cost per hour — the primary alert metric
tutor_cost_usd_per_hour{namespace="redquant-prod"}

# Users near/over the 50k token/day hard ceiling (§9)
sum(increase(tutor_tokens_total{namespace="redquant-prod"}[24h])) by (user_id) > 50000

# Cost-per-request inflation check — compare side by side
sum(rate(tutor_requests_total{namespace="redquant-prod"}[5m]))
# against tutor_cost_usd_per_hour: flat request volume + climbing cost = per-request cost inflation

# Retry-storm detection
sum(rate(tutor_requests_total{namespace="redquant-prod", status="retry"}[5m]))
```

---

## 3. Decision tree

```mermaid
flowchart TD
    A[TutorCostPerHourHigh alert] --> B{Per-user token distribution has clear outliers?}
    B -->|Yes, small set of users dominate| C[ABUSE — block specific user(s)]
    B -->|No, broad distribution| D{Cost-per-request climbing while volume flat?}
    D -->|Yes| E[PROMPT-ASSEMBLY BUG — check recent ai-tutor deploys, consider rollback]
    D -->|No| F{Request volume itself spiking abnormally?}
    F -->|Yes, correlated with upstream errors| G[RETRY STORM — check upstream error rate, fix/pause backoff]
    F -->|No — smooth, broad, proportional growth| H[LEGITIMATE GROWTH — capacity planning, not incident suppression]

    C --> I{Auto-downgrade DEGRADE_TUTOR_RETRIEVAL_ONLY already engaged?}
    E --> I
    G --> I
    I -->|No, and cost is over ceiling| J[SEV1 — safety mechanism failed. Engage manually now.]
    I -->|Yes| K[Confirm holding cost under ceiling, address root cause per branch above]
```

Numbered prose:

1. Check per-user token consumption distribution. A small set of users
   driving disproportionate volume points to **abuse**.
2. If broad and not user-concentrated, check whether average
   tokens-per-request is climbing while request volume stays flat — that
   pattern is the signature of a **prompt-assembly bug** (context being
   appended without truncation).
3. If request volume itself is spiking abnormally, correlated with an
   upstream error rate, that's a **retry storm** — the tutor worker retrying
   without adequate backoff, multiplying effective request volume and cost.
4. If none of the above — broad, gradual, proportional growth across many
   users, cost and volume rising together smoothly, no per-user or
   per-request outliers — this is **legitimate organic growth**. The correct
   response is capacity/ceiling planning, not incident suppression.
5. Regardless of root cause, first check whether the automatic downgrade
   (§9 step 3, `DEGRADE_TUTOR_RETRIEVAL_ONLY`) has already engaged. If cost
   is over ceiling and it has **not** engaged, that is itself a SEV1 — the
   safety mechanism failed — engage it manually immediately, then diagnose
   root cause in parallel.

---

## 4. Procedures

### 4.1 Confirming the auto-downgrade state

Check whether it already engaged (it should have, automatically, per §9
step 3):
```
kubectl get configmap ai-tutor-config -n redquant-prod -o jsonpath='{.data.DEGRADE_TUTOR_RETRIEVAL_ONLY}'
```

**If cost is over ceiling and this returns `false` — this is the SEV1
case: the safety mechanism failed.** Engage manually, looping over every
namespace `ai-tutor` runs in:
```
for ns in redquant-prod redquant-cell-0 redquant-cell-1 redquant-cell-2 redquant-cell-3; do
  kubectl patch configmap ai-tutor-config -n $ns --type merge -p '{"data":{"DEGRADE_TUTOR_RETRIEVAL_ONLY":"true"}}'
  kubectl rollout restart deployment/ai-tutor -n $ns
done
```

### 4.2 Lowering the ceiling further

If retrieval-only alone isn't stopping spend growth fast enough (retrieval
mode still carries some inference cost for retrieval/embedding, just far
less than full generation), lower the configurable hourly ceiling:
```
kubectl patch configmap ai-tutor-config -n redquant-prod --type merge \
  -p '{"data":{"TUTOR_HOURLY_COST_CEILING_USD":"<lower-value>"}}'
kubectl rollout restart deployment/ai-tutor -n redquant-prod
```

### 4.3 Blocking a specific abusive user

Identify top-N token consumers from the PromQL in §2, then block tutor
access for that user specifically — not a full account suspension unless
abuse is broader than tutor usage:
```
kubectl exec -n redquant-prod redquant-pg-1 -- psql -U postgres -d redquant -c \
  "UPDATE identity.users SET tutor_blocked=true WHERE id = '{{user_id}}';"
```
Since entitlements are cached in the session (§7), force a re-evaluation by
invalidating that user's active session(s) so the block takes effect
immediately rather than waiting for natural session expiry:
```
kubectl exec -n redquant-prod redis-cluster-0 -- redis-cli -c DEL sess:{{sid}}
```
This is the same entitlement-cache-invalidation pattern used in
[stripe-webhook-backlog.md](stripe-webhook-backlog.md) for manual
entitlement grants — the cache always needs an explicit invalidation nudge,
it does not self-correct on a DB change alone.

### 4.4 Draining the queue

If `ai-tutor` requests are backed up in a queue (e.g. `bull:tutor:requests`),
check depth:
```
kubectl exec -n redquant-prod redis-cluster-0 -- redis-cli -c LLEN bull:tutor:requests:wait
```
Surgical per-user purging of queued jobs is **not** reliably done with a raw
`redis-cli` one-liner — BullMQ's queue structure doesn't support a simple
per-user filter-and-delete primitive. Be honest about this rather than
improvising a risky ad-hoc script under pressure. The safer blunt option, if
a runaway is severe and immediate (spend on pace to blow past the entire
monthly $9-16k envelope within hours):

**⚠️ Bold warning — requires explicit second-person confirmation. This stops
tutor service for ALL users, not just the abusive ones.**
```
kubectl scale deployment/ai-tutor -n redquant-prod --replicas=0
```

### 4.5 The $9-16k/month envelope — doing the arithmetic

$9,000-$16,000/month ÷ ~730 hours/month ≈ **$12.33/hour to $21.92/hour**
average sustainable rate.

This is an **average**, not a ceiling — usage isn't flat across the day or
week. A well-calibrated hourly ceiling should sit meaningfully above the
pure average to accommodate legitimate peak-usage hours without
false-triggering the degrade, while staying low enough to catch a genuine
runaway quickly.

Illustrative example: a **$35-40/hour ceiling** allows roughly 1.6-3x the
average rate during peak hours before triggering degrade, while capping
worst-case monthly spend — if sustained continuously at the ceiling, which
would itself be an ongoing incident, not normal operation — at roughly
ceiling × 730h ≈ **$25.5k-$29.2k**. That worst-case number is the real
exposure if the hourly ceiling were the *only* control in the system; in
practice the per-user 50k token/day hard ceiling and per-plan message
limits (§7) bound things further upstream of the aggregate cost metric.

**The actual configured ceiling is an operational parameter that may have
been tuned since this runbook was written — read it from the live
configmap, don't assume the illustrative numbers above:**
```
kubectl get configmap ai-tutor-config -n redquant-prod -o jsonpath='{.data.TUTOR_HOURLY_COST_CEILING_USD}'
```

### 4.6 Diagnosing the four root causes

- **Abuse**: query per-user token distribution (§2 PromQL) for outliers.
- **Prompt-assembly bug**: check the average-tokens-per-request trend, and
  check whether it started right after a recent `ai-tutor` deploy:
  ```
  kubectl rollout history deployment/ai-tutor -n redquant-prod
  ```
  If correlated with a recent release, **rollback is the fix**, not just
  degrade:
  ```
  kubectl rollout undo deployment/ai-tutor -n redquant-prod
  ```
- **Retry storm**: check retry/error-rate metrics (§2) and the upstream
  Claude API's own status. If confirmed, check/fix the retry-backoff
  configuration, or manually pause (scale down, §4.4) while the backoff bug
  is fixed.
- **Legitimate growth**: smooth, broad growth across many users with no
  per-user or per-request outliers. The action here is capacity planning —
  raising HPA max, or a deliberate conversation with Finance about raising
  the monthly envelope — not incident suppression.

---

## 5. Verification

- `tutor_cost_usd_per_hour` trending back under the configured ceiling.
- If triggered, retrieval-only mode confirmed actually engaged — spot check
  a real tutor response and confirm it is labelled as retrieval-only with
  citations, per §9's "sheds load without lying to the user" (not a silent
  quality downgrade).
- If a user was blocked, confirm their session now returns the blocked
  behavior (retrieval-only or hard block, depending on how it's
  implemented), not the old cached entitlement.

## 6. Rollback / if this makes it worse

- If `ai-tutor` was scaled to 0 as an emergency stop (§4.4), re-enable as
  soon as root cause is contained, back to the §1 fleet-sizing steady-state
  replica count:
  ```
  kubectl scale deployment/ai-tutor -n redquant-prod --replicas=6
  ```
- If a rollback (`rollout undo`) didn't fix cost inflation, re-examine the
  diagnosis in §4.6 — the correlation with the deploy may have been
  coincidental.
- If the hourly ceiling was lowered too aggressively and is now forcing
  retrieval-only for all users unnecessarily, raise it back once the
  original incident is confirmed resolved and root-caused.

## 7. Comms

Use the SEV2/SEV1 templates from [oncall.md](oncall.md). Customer-facing
wording should acknowledge degraded tutor quality honestly during the
incident window — "the AI tutor is temporarily providing retrieval-based
answers with citations while we address a cost/capacity issue," matching
§9's principle of not hiding a degradation from users.

## 8. Post-incident

Capture:
- Root cause classification (abuse / prompt-assembly bug / retry storm /
  legitimate growth).
- Actual $ spent during the incident window vs the $9-16k/month envelope.
- Whether the automatic safety mechanism (§9 step 3) worked as designed, or
  required manual intervention — if manual intervention was needed, this is
  itself a follow-up item: fix the automatic mechanism, don't just rely on
  a human catching it next time.
- Any plan-ceiling or hourly-ceiling tuning follow-ups warranted by what was
  learned.

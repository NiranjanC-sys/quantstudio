# Cell canary rollout

RedQuant shards its 50,000 concurrent users into 4 cells of ~12,500 users each
(`hash(user_id) % 4`, see `docs/architecture/system-design.md` §2). Each cell is
a full vertical slice (web, api, quantum-kernel(-heavy), sandbox-runner,
grader, ai-tutor) in its own namespace (`redquant-cell-<id>`), built from
`infra/k8s/base` plus the `cells/component` Component. Postgres stays
regionally shared; everything else is cell-local, so a bad deploy is contained
to one cell instead of all 50k users.

Rollout order (per SPEC.md §2): **cell-0 (internal) → cell-1 → cell-2 & cell-3
(parallel)**.

- cell-0 carries internal/staff traffic only (routed there by the
  `hash(user_id) % 4` shard map plus an internal-user override at the edge) —
  it is the canary.
- cell-1 is the first real-user cell. Only proceed to cell-2/3 once cell-1 has
  baked clean.
- cell-2 and cell-3 roll out together once cell-1 is healthy, since by that
  point the change has already had two independent bake windows.

## Preconditions

- The change has already passed `overlays/staging` soak.
- `kubectl kustomize infra/k8s/cells/cell-<id>` diffs cleanly against what's
  live (no unrelated drift).
- An on-call engineer is watching dashboards for the duration of the rollout
  (this is not a fire-and-forget rollout).

## Step 1 — cell-0 (internal)

```sh
# Build and review the diff before applying.
kubectl kustomize infra/k8s/cells/cell-0 > /tmp/cell-0.yaml
kubectl diff -f /tmp/cell-0.yaml

# Apply.
kubectl apply -f /tmp/cell-0.yaml

# Watch the rollout complete for every Deployment in the cell.
kubectl -n redquant-cell-0 get deploy -o name | \
  xargs -n1 -I{} kubectl -n redquant-cell-0 rollout status {} --timeout=5m
```

**Bake time: 30 minutes minimum** (internal traffic is low-volume; this window
exists mainly to catch crash-loops, config errors, and startup regressions,
not load-driven ones).

**Watch:**
- Per-journey dashboards ("read a lesson", "run a lab", "join a contest") for
  cell-0 — SPEC.md §11.
- SLO burn-rate alerts (read availability 99.95%, submission durability
  99.999%) — never raw CPU (§9/§11).
- Domain metrics: `sim_queue_depth`, `sim_cache_hit_ratio`,
  `grader_lag_seconds`, `contest_broadcast_lag_ms`, `tutor_cost_usd_per_hour`,
  `entitlement_denial_rate` (§11), scoped to `namespace="redquant-cell-0"`.
- Pod restarts / OOMKills: `kubectl -n redquant-cell-0 get pods --field-selector=status.phase!=Running`.

If clean after the bake window, proceed. If not, roll back (Step 4) and stop.

## Step 2 — cell-1

```sh
kubectl kustomize infra/k8s/cells/cell-1 > /tmp/cell-1.yaml
kubectl diff -f /tmp/cell-1.yaml
kubectl apply -f /tmp/cell-1.yaml

kubectl -n redquant-cell-1 get deploy -o name | \
  xargs -n1 -I{} kubectl -n redquant-cell-1 rollout status {} --timeout=5m
```

**Bake time: 60 minutes minimum** (first exposure to ~12,500 real users; this
window should span at least one contest-adjacent traffic peak if one is
scheduled, per §6).

**Watch:** same signals as Step 1, scoped to `namespace="redquant-cell-1"`,
plus:
- `time_to_first_amplitude` RUM budget (120 ms, §11) — regressions here
  indicate a client-sim (T-A) or asset regression.
- Contest scoring correctness stays 100% if a contest is live in this cell
  (post-contest replay diff, §9) — do not roll forward through a live contest
  window unless the change is contest-critical (a fix for an active incident).
- Compare cell-1 error rate / p99 latency against cell-0 and against the
  pre-rollout baseline for cell-1 itself.

If clean, proceed. If not, roll back cell-1 only (Step 4) — cell-0 is
unaffected and can keep the new version if it's healthy.

## Step 3 — cell-2 & cell-3 (parallel)

```sh
kubectl kustomize infra/k8s/cells/cell-2 > /tmp/cell-2.yaml
kubectl kustomize infra/k8s/cells/cell-3 > /tmp/cell-3.yaml
kubectl diff -f /tmp/cell-2.yaml
kubectl diff -f /tmp/cell-3.yaml
kubectl apply -f /tmp/cell-2.yaml
kubectl apply -f /tmp/cell-3.yaml

for c in cell-2 cell-3; do
  kubectl -n redquant-$c get deploy -o name | \
    xargs -n1 -I{} kubectl -n redquant-$c rollout status {} --timeout=5m
done
```

**Bake time: 60 minutes**, watched the same way, scoped to both namespaces.
At this point the change has already survived cell-0 and cell-1, so this step
is a blast-radius-limited confirmation, not primary validation.

## Rollback

Cells are independent, so roll back only the affected cell(s). Roll back by
re-applying the previous manifest revision (kept in version control /
whatever CD history you have), not by hand-editing live objects:

```sh
# Roll back a single cell to the previous known-good revision (example uses
# git, adjust to your actual release/tag mechanism):
git show <previous-good-ref>:infra/k8s/cells/cell-<id> > /tmp/rollback
kubectl kustomize <that-checkout>/infra/k8s/cells/cell-<id> > /tmp/cell-<id>-rollback.yaml
kubectl apply -f /tmp/cell-<id>-rollback.yaml

kubectl -n redquant-cell-<id> get deploy -o name | \
  xargs -n1 -I{} kubectl -n redquant-cell-<id> rollout status {} --timeout=5m
```

If the underlying image is the problem rather than the manifest, a faster
rollback is `kubectl -n redquant-cell-<id> rollout undo deployment/<svc>` per
affected Deployment — but reconcile the manifest source (base image tag in
`infra/k8s/base/kustomization.yaml`) afterwards so the next `kubectl apply`
doesn't roll the bad version back out.

Do not roll back cells that are healthy just because a later cell in the
sequence failed — that defeats the purpose of cell isolation.

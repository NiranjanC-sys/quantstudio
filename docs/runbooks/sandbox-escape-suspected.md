---
title: Suspected Sandbox Escape Runbook
severity_range: SEV1 always — confirmed or credibly suspected escape
owning_team: Security/AppSec + Platform SRE (joint)
page_policy: always page, always page Security on-call
expected_time_to_mitigate: containment target 10 minutes
last_reviewed: 2026-08-29
---

# Suspected Sandbox Escape Runbook

**Containment first, forensics second.** This is the organizing principle of
this entire document. If you take one thing from this runbook under
pressure, take this: stop the bleeding before you understand the wound. Every
minute spent investigating before containment is a minute the exposure
window stays open. The procedures section below is split into a
**Containment (minutes 0-10)** subsection and a **Forensics (after
containment confirmed)** subsection — do not reorder them, and do not skip
ahead to forensics because it feels more informative. It isn't, until
containment is done.

Covers §10 (sandbox: executing untrusted quantum code) of system-design.md.
See also: [oncall.md](oncall.md) for severity/escalation — a confirmed
sandbox escape is automatically SEV1 and, per oncall.md's escalation ladder,
triggers exec/VP comms regardless of elapsed time.
[postgres-failover.md](postgres-failover.md),
[redis-cluster-incident.md](redis-cluster-incident.md),
[simulation-saturation.md](simulation-saturation.md),
[contest-day.md](contest-day.md),
[stripe-webhook-backlog.md](stripe-webhook-backlog.md),
[ai-tutor-cost-runaway.md](ai-tutor-cost-runaway.md) — cross-referenced as
needed, not directly relevant here.

Infra: gVisor (`runsc`) `RuntimeClass`, one process per submission,
read-only root filesystem, `tmpfs` scratch 64 MiB. **No network** — empty
network namespace, an absent interface, not a firewall rule. Limits: 2s CPU
(10s for projects), 512 MiB RSS, 64 processes, 4 MiB stdout, wall-clock kill
at 3× the CPU limit. Seccomp reduces the syscall surface to the ~60 calls
CPython + NumPy need. Import allowlist: `numpy`, `qiskit`, `cirq`,
`pennylane`, `scipy`, `math`, `itertools`, `typing`; explicitly denied:
`os`, `sys`, `subprocess`, `socket`, `ctypes`. Deterministic execution
(seeded RNG, frozen wall clock). Runners are single-use: the pod is recycled
after N=50 executions. Deployment `sandbox-runner`, present in
`redquant-prod` and each `redquant-cell-0..3` (sandbox is part of the
per-cell vertical slice, §2). Baseline pod security (all pods, per repo
convention): `runAsNonRoot`, uid 10001, `readOnlyRootFilesystem`, all
capabilities dropped, `seccompProfile: RuntimeDefault`,
`allowPrivilegeEscalation: false` — gVisor and the empty-egress
`NetworkPolicy` are **additional** controls layered on top of this baseline,
not a replacement for it.

---

## 1. Symptoms

What would actually indicate a suspected escape — given that most of these
should be structurally impossible per §10, **any occurrence is itself the
alert condition**, not just a large volume of occurrences:

- An outbound network connection attempt from a sandbox pod, or a
  `NetworkPolicy` deny-log hit for a sandbox pod. Should be impossible given
  the empty network namespace — any observed attempt means either an escape
  attempt in progress, or a control that was never actually in force being
  tested (see §5.7-5.8 for how to prove it either way).
- A volume spike in seccomp-denied syscalls — may indicate active probing
  for a bypass.
- A sandbox process that outlives its wall-clock or CPU limit without being
  killed — the limit enforcement itself may have failed.
- A filesystem write attempted outside the `tmpfs` scratch area.
- Child process count for a submission approaching the 64-process limit
  repeatedly.
- CPU/RSS usage spiking right at the limit boundary, repeatedly, across
  many submissions from the same source — classic probing behavior, testing
  where the walls are.
- Any successful import outside the allowlist — should be impossible if the
  loader is working; a signal the loader itself is broken.
- Anomalous outbound DNS or connect attempts visible in **node-level** flow
  logs, even though the pod's own network namespace is empty. This is the
  **most severe case** — it would imply the escape bypassed the pod netns
  entirely, i.e. an actual gVisor kernel escape, not just an in-sandbox
  attempt that got blocked as designed.

Alert names: `SandboxEgressAttemptDetected`, `SandboxSyscallDenialSpike`,
`SandboxProcessLimitApproached`, `SandboxWallClockKillRateHigh`.

---

## 2. Dashboards to open

There is no dedicated named journey dashboard for sandbox security per se —
the three §11 journey dashboards are `journey-read-a-lesson`,
`journey-run-a-lab`, and `journey-join-a-contest`. Sandbox execution happens
inside `journey-run-a-lab` (and the lab-grading path of
`journey-join-a-contest`), so start there for user-facing impact, but you
will primarily be working from a sandbox-security-specific dashboard/panel
set if one exists in your Grafana instance, covering: seccomp denial rate,
`NetworkPolicy` drop counts, process/CPU/RSS limit breaches, and runner
recycle rate (are runners hitting their normal N=50 recycle, or dying early,
or being killed).

Exact PromQL:

```promql
# Seccomp denials by syscall — should be near-zero baseline (occasional
# legitimate denials from numpy/scipy probing for optional syscalls are normal, see §5.6)
sum(rate(sandbox_seccomp_denials_total{namespace=~"redquant-.*"}[5m])) by (syscall)

# NetworkPolicy drops — should be a flatline zero, always. Any nonzero value IS the alert.
sum(rate(sandbox_network_policy_drops_total{namespace=~"redquant-.*"}[5m]))

# Process count vs the 64-process limit
sandbox_process_count{namespace=~"redquant-.*"}

# Wall-clock kill rate (kills at 3x the CPU limit)
sum(rate(sandbox_wallclock_kill_total{namespace=~"redquant-.*"}[5m]))
```

---

## 3. Decision tree

```mermaid
flowchart TD
    A[Sandbox alert or report] --> B{Plausibly an escape, or a known benign pattern?}
    B -->|Uncertain either way| C[CONTAIN FIRST regardless of uncertainty]
    B -->|Clearly matches a false-positive pattern, §5.6| D[Log and review, no full containment required]
    B -->|Plausible or confirmed escape| C

    C --> C1[Freeze node pool: cordon affected node(s)]
    C1 --> C2[Drain: evict running pods. Bold warning — kills in-flight executions, intended.]
    C2 --> C3[Scale sandbox-runner to 0 across all namespaces. Bold warning.]
    C3 --> C4[Revoke affected submissions — quarantine, do not delete, evidence]
    C4 --> C5[Block submitting account(s). Bold warning — confirm identity first.]
    C5 --> C6[Rotate node-reachable credentials]
    C6 --> C7[Verify empty-egress NetworkPolicy actually in force]
    C7 --> C8[Verify gVisor RuntimeClass actually in force]
    C8 --> E{Containment confirmed?}
    E -->|No, controls not actually in force| C1
    E -->|Yes| F[Proceed to Forensics]

    D --> G[Log finding, note pattern, continue monitoring]

    F --> F1[Snapshot node]
    F1 --> F2[Preserve pod logs + runsc logs]
    F2 --> F3[Pull submitted code]
    F3 --> F4[Walk §10 controls checklist — which control failed?]
    F4 --> F5[Legal/disclosure assessment]
    F5 --> F6[Mandatory RCA]
```

Numbered prose:

1. Assess plausibility: does this match a known benign pattern (§5.6 false
   positives) or is it plausible/confirmed? **When genuinely uncertain,
   contain anyway** — false-positive determination should scope or shorten
   containment, never block it. Containment is cheap; an actual escape is
   not.
2. If clearly benign and isolated, log it, note the pattern, and continue
   monitoring without full containment escalation.
3. Otherwise, execute containment steps 1 through 8 in order (below), each
   one building on the last.
4. Only once containment is confirmed — controls verified in force on any
   remaining/new pods, `sandbox-runner` at zero replicas, affected
   submissions and accounts locked down — proceed to forensics.
5. Forensics walks the full §10 controls checklist to determine which
   specific control failed, preserves evidence with chain of custody, and
   feeds Legal/disclosure and the mandatory RCA.

---

## 4. Procedures — Containment (minutes 0-10)

All commands are namespace-aware; loop over `redquant-prod` and
`redquant-cell-0..3` since `sandbox-runner` exists per-cell (§2).

**1. Freeze the sandbox node pool.** Prevent new pods scheduling onto the
affected node(s):
```
kubectl cordon <node-name>
```
If you don't yet know which specific node(s) are affected, cordon the whole
sandbox-runner-dedicated node pool by label:
```
kubectl get nodes -l node-pool=sandbox-runner -o name | xargs -I{} kubectl cordon {}
```

**2. Cordon + drain.** ⚠️ **Draining kills in-flight executions — this is
intended, not a side effect to avoid.** Requires second-person confirmation
before running:
```
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data --force --grace-period=0 -n redquant-prod
```

**3. Scale `sandbox-runner` to 0** across every affected namespace. ⚠️ **Bold
warning — this halts ALL lab and contest grading platform-wide. Requires
second-person confirmation.**
```
for ns in redquant-prod redquant-cell-0 redquant-cell-1 redquant-cell-2 redquant-cell-3; do
  kubectl scale deployment/sandbox-runner -n $ns --replicas=0
done
```
Comms must immediately reflect "labs/contests temporarily unavailable" — see
§8.

**4. Revoke the affected submissions.** Identify them by correlating pod
name / node / execution timestamp against `labs.submissions` and
`contest.submissions`. Mark as quarantined — **do not delete, this is
evidence**:
```
kubectl exec -n redquant-prod redquant-pg-1 -- psql -U postgres -d redquant -c \
  "UPDATE labs.submissions SET status='quarantined', quarantine_reason='suspected sandbox escape {{incident_id}}' WHERE id IN ({{submission_ids}});"
```

**5. Block the submitting account(s).** ⚠️ **Bold warning — confirm identity
carefully before suspending; a false positive here harms a real user.**
```
kubectl exec -n redquant-prod redquant-pg-1 -- psql -U postgres -d redquant -c \
  "UPDATE identity.users SET status='suspended', suspended_reason='security hold - suspected sandbox escape' WHERE id = '{{user_id}}';"
```
Force-revoke their active sessions:
```
kubectl exec -n redquant-prod redis-cluster-0 -- redis-cli -c DEL sess:{{sid}}
```

**6. Rotate any credential reachable from the node.** Given the empty-egress
control (§10), a real escape's realistic blast radius is **local-node**
secrets and tokens: node IAM role / instance profile credentials, any
node-local service-account tokens, IMDS credentials if applicable, and the
node's kubelet client certificate if compromise of the node itself (not just
the sandbox process) is suspected. **Coordinate with the Platform infra team
for the exact cloud-credential rotation commands — do not guess at cloud API
calls under incident pressure without infra-team confirmation.** What must
happen is clear even if the exact command isn't yours to run solo:
node-level credentials reachable from that node need rotating, now.

**7. Verify the empty-egress `NetworkPolicy` is actually in force — prove
it, don't assume it.** Check the resource:
```
kubectl get networkpolicy -n redquant-prod -l app.kubernetes.io/name=sandbox-runner -o yaml
```
Confirm an explicit deny-all-egress policy exists and its pod selector
actually matches the sandbox-runner pods. A YAML resource existing does not
prove enforcement — cross-check the pod's actual interface state as well.
The correct way to verify "absent interface" is via the pod spec and, if
node access is available, the node's own network-namespace listing, not by
attempting a connection from inside a sandbox pod (there is no tooling
inside the sandbox to test connectivity, and even if there were, a
successful connection attempt would itself be the incident):
```
kubectl get pod <sandbox-pod> -n redquant-prod -o jsonpath='{.spec}' | jq .
ip netns exec <pod-network-namespace> ip link show   # run on the node, if node access is available
```
If any recently-scheduled sandbox pod shows a network interface where none
should exist, that is itself a control failure, independent of whether an
escape occurred through it.

**8. Verify the gVisor `RuntimeClass` is actually in force.**
```
kubectl get pod <sandbox-pod-name> -n redquant-prod -o jsonpath='{.spec.runtimeClassName}'
```
Must return the cluster's gVisor RuntimeClass name (e.g. `gvisor`). Cross
check the RuntimeClass resource itself and that containerd's configured
handler matches:
```
kubectl get runtimeclass gvisor -o yaml
```
**If any recently-scheduled sandbox pod shows an empty or wrong
`runtimeClassName`, that is a control failure in itself** — it means gVisor
was not actually applied to some submissions. Go find every pod that ran
without it; each one needs to be treated as a potentially higher-risk
execution for forensics purposes.

---

## 5. Procedures — Forensics (after containment confirmed)

**1. Snapshot the node.** If on a cloud VM, snapshot the affected node's
disk/volume **before** any further changes and before autoscaling has a
chance to recycle/terminate it. Coordinate with Platform infra for the exact
cloud snapshot command — the requirement (snapshot now, before the node
disappears) is what matters; the exact API call is infra-team territory.

**2. Preserve pod logs and `runsc` logs.**
```
kubectl logs <sandbox-pod-name> -n redquant-prod --previous > /forensics/incident-{{incident_id}}/pod.log
```
gVisor's own `runsc` debug/strace-level logs, if the RuntimeClass is
configured to emit them, typically live under a hostPath mount or are
shipped by a sidecar collector — confirm the actual log location with the
Platform team who configured the gVisor RuntimeClass in this cluster rather
than guessing a path under incident pressure.

**3. Pull the submitted code.** From the `labs.submissions` /
`contest.submissions` payload column (or wherever submitted source is
stored) for the specific execution(s) in question, and preserve a copy
outside the live system before any retention policy could touch it.

**4. Walk the §10 controls checklist — determine which control failed.**
Go through every control explicitly, one at a time, for this specific
incident:

- **gVisor**: was the RuntimeClass actually applied? (See containment step
  8.)
- **Empty netns**: was the network interface actually absent? (See
  containment step 7.)
- **Seccomp (~60 syscalls)**: check seccomp denial logs for this
  submission's process. Did something get through that should have been
  denied — or, worse, was a syscall not actually restricted in the deployed
  seccomp profile?
- **Import allowlist** (`numpy`, `qiskit`, `cirq`, `pennylane`, `scipy`,
  `math`, `itertools`, `typing` allowed; `os`, `sys`, `subprocess`,
  `socket`, `ctypes` denied): did the submitted code manage a denied import?
  Check for obfuscation techniques — dynamic `__import__` calls, pickle
  deserialization gadgets, or an allowlisted package that itself
  unexpectedly imports a denied module as a transitive dependency.
- **RSS/CPU/process/stdout limits**: were they actually enforced at the
  moment of the incident, or had the underlying cgroup/rlimit configuration
  drifted from what §10 specifies?
- **The 50-execution recycle**: was this specific runner pod near its 50th
  execution? Could stale state have accumulated across executions on the
  same recycled pod in a way that contributed to the incident?

**5. Legal/disclosure and who to notify.** Notify the Security lead and
Legal/Privacy. Evaluate blast radius honestly: given empty egress, if that
control genuinely held, there was realistically no external exfiltration
path regardless of what happened inside the sandbox process. Whether this
rises to a disclosable security incident depends on jurisdiction and
contractual obligations with Campus/Teams customers (SOC2/compliance
terms) — this is **Legal's decision to make**, not SRE's. Your job is to
hand Legal an accurate, complete technical timeline, not to decide
disclosure yourselves.

**6. False-positive triage — indicators this was NOT an escape.** Review
these before treating every anomaly as confirmed:
- A single seccomp denial for a legitimate allowlisted-package operation
  that happens to probe for an optional syscall and gracefully falls back —
  some numpy/scipy code paths do this; it is normal, not an escape.
- A wall-clock kill on a single submission with no surrounding pattern —
  just a slow or inefficient submitted algorithm hitting the CPU limit. This
  happens regularly and is expected.
- A single `NetworkPolicy` log entry that turns out to be the CNI's own
  health-check traffic misattributed to the pod's namespace (a rare CNI
  logging artifact, not sandbox behavior).
- An isolated `SandboxProcessLimitApproached` from a legitimate submission
  using multiprocessing within allowlisted numpy/scipy — inefficient, not
  malicious.

Even a benign-matching finding should still be reviewed and logged. It does
not require full containment escalation **if truly isolated and clearly
matching one of the patterns above**. Use judgment — and when genuinely in
doubt, contain anyway. That principle does not go away just because you've
reached the forensics section.

---

## 6. Verification

- Containment confirmed: affected node(s) cordoned and drained,
  `sandbox-runner` at 0 replicas everywhere it was scaled down, both
  `NetworkPolicy` and gVisor `RuntimeClass` verified in force on any
  remaining or newly-scheduled sandbox pods.
- Forensics artifacts collected and preserved with chain of custody —
  timestamps and collector identity recorded for every artifact.

## 7. Rollback / if this makes it worse

- Scaling `sandbox-runner` to 0 platform-wide will cause the `grader` KEDA
  `ScaledObject` to scale workers up against an empty/growing queue with
  nothing to grade, and the grade queue will back up indefinitely. This is
  an **acceptable and expected tradeoff** during containment — note it in
  the timeline, don't treat it as a separate incident.
- If a node was cordoned based on a finding later determined to be a false
  positive (per §5.6), uncordon it:
  ```
  kubectl uncordon <node-name>
  ```

## 8. Comms

This incident has different comms needs from ordinary SRE incidents:
1. **Internal security escalation first.** Do not default to public
   status-page wording until Security/Legal have assessed the situation.
2. **Internal security channel template**:
   ```
   [SEV1 - SECURITY] Suspected sandbox escape — containment in progress
   Affected node(s): {{node_names}}
   Affected submission(s): {{submission_ids}}
   Containment status: {{containment_status}}
   Security lead: {{security_lead_name}}
   ```
3. **Eventual customer-facing wording**, only after Legal sign-off if
   determined disclosable — conservative and factual:
   ```
   {{status_icon}} We identified and contained a security issue affecting
   our code-execution sandbox. {{public_impact_description}}. Labs and
   contest grading were briefly unavailable while we resolved it.
   ```

## 9. Post-incident

- **Mandatory RCA for any confirmed escape** — no exceptions.
- Control hardening follow-ups: does seccomp need tightening further, does
  the import allowlist need another denial added, should the 50-execution
  recycle count be lowered given what was found?
- Retroactive review of **every other submission** executed on the same
  recycled runner pod before this incident (up to 49 prior executions on
  that pod) — state could in principle have leaked between executions on a
  recycled pod, and this needs explicit ruling-out, not assumption.

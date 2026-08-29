## Summary

<!-- What does this change do, and why? Link the issue/ticket if there is one. -->

## Type of change

- [ ] Feature
- [ ] Fix
- [ ] Refactor / cleanup
- [ ] Infra / CI-CD
- [ ] Docs
- [ ] Dependency bump

## Affected services

<!-- Check everything this PR touches. -->

- [ ] web
- [ ] api / ws-gateway
- [ ] quantum-kernel (incl. quantum-kernel-heavy)
- [ ] sandbox-runner
- [ ] grader
- [ ] ai-tutor
- [ ] infra/docker
- [ ] infra/k8s (base / overlays / cells)
- [ ] infra/loadtest
- [ ] .github (CI/CD)

## Correctness-sensitive areas

<!-- Call out anything touching these; they have zero-tolerance failure modes
     documented in docs/architecture/system-design.md. Remove lines that don't apply. -->

- [ ] Contest scoring / leaderboard path (§6) — monotonicity and idempotency preserved
- [ ] Simulation tiers T-A/T-B/T-C or the result cache key (§4)
- [ ] Credits / entitlements ledger (§7) — debit still happens in the same transaction as job enqueue
- [ ] Sandbox isolation limits or syscall/import allowlist (§10)
- [ ] Rate limits or the degradation ladder (§9)
- [ ] Auth, SSO, or session handling (§8)

## How was this tested?

<!-- Unit / integration / e2e / manual. Include commands run and their output where useful. -->

## Checklist

- [ ] `pnpm -r typecheck && pnpm -r lint && pnpm -r test` pass locally (or CI is green)
- [ ] No `latest` image tags introduced (Kyverno rejects them)
- [ ] No secrets, tokens, or credentials committed (checked, not just assumed)
- [ ] Docs (`docs/architecture/system-design.md` or scratchpad SPEC) updated if this changes a contract, SLO, or capacity number
- [ ] Backwards-compatible migration, or migration plan noted below

## Rollout / rollback notes

<!-- Cell rollout order is cell-0 (internal) -> cell-1 -> cell-2 & cell-3. Note any
     manual steps, feature flags, or config that need to change before/after merge. -->

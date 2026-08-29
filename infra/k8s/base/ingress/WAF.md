# WAF strategy

Two layers, per system-design.md §2 ("Cloudflare / CDN ... WAF, bot mgmt, 95%
offload") and §9 (rate limits).

## Layer 1: Cloudflare, at the edge

- Sits in front of everything (`§2` topology diagram): static assets, MDX HTML,
  images, the client-side WASM simulator. Cloudflare's cache offloads ~95% of
  edge requests before they ever reach the origin ALB, which is why the origin
  fleet in §1 is sized for 1,500 rps steady / 3,500 rps peak instead of the
  ~10,000 rps peak seen at the edge.
- **Managed rulesets**: Cloudflare Managed Ruleset + OWASP Core Ruleset, in
  `Log` mode for two weeks on any new rule bundle before flipping to `Block`
  (see the tuning procedure below).
- **Bot management**: Cloudflare Bot Management score-based blocking on
  auth (`/api/auth/*`), checkout, and contest-submission routes. Score
  threshold starts conservative (block only "definitely automated") and is
  tightened only after a burn-in period with no false positives against real
  learner traffic during a contest window (the highest-legitimate-automation
  traffic shape we have: bursts to ~1,300 rps at deadline, §1).
- **Rate limit rules mirroring §9**: Cloudflare rate-limiting rules are the
  first enforcement point for the same budgets enforced again at the
  ingress/API layer (defence in depth, not a single point of truth):
  - Read: 120 requests / 10s per (IP, session)
  - Auth: 10 requests / 10 min per IP, exponential backoff on repeated
    violation
  - Contest submission: 10 / min per user, plus the 20s per-problem cooldown
    is left to the API layer (Cloudflare doesn't have problem-scoped state)
  - Everything else (server sim, lab submit, AI tutor) is edge-rate-limited
    only at a coarse per-IP ceiling; the plan-aware/credit-aware limits live
    in Redis token buckets at the API gateway, because Cloudflare has no
    visibility into subscription tier.

## Layer 2: ModSecurity + OWASP CRS at nginx-ingress

Second layer, inside the cluster, in case the edge is bypassed (direct-to-ALB
probing, a Cloudflare outage, or a rule gap). Enabled via
`nginx.ingress.kubernetes.io/enable-modsecurity` and
`enable-owasp-core-rules` on both Ingress objects in `ingress-nginx.yaml`.

## What is intentionally NOT blocked

**Learner code in lab/contest submissions must be allowed to contain
shell-looking strings.** A learner's Python submission body
(`POST /contests/:id/submit`, `POST /labs/:id/submit`) legitimately contains
things that a generic WAF ruleset flags as attack payloads: `import os`,
`subprocess`, backtick-free shell-style tokens inside docstrings, SQL-looking
strings in a query-simulation exercise, base64 blobs in an encoding lab, etc.
None of that is dangerous at the HTTP layer -- the actual security boundary
for untrusted code is the gVisor sandbox described in §10 (empty network
namespace, read-only rootfs, seccomp, import allowlist), not the WAF. A CRS
rule that pattern-matches on `os.system(`, `subprocess.Popen(`, or similar in
a request body would produce constant false positives on exactly the traffic
this product exists to accept.

Concretely, the submission endpoints
(`/api/labs/*/submit`, `/api/contests/*/submissions`) run with CRS in
**paranoia level 1** and with the injection-family rule groups
(`REQUEST-932-APPLICATION-ATTACK-RCE`, `REQUEST-942-APPLICATION-ATTACK-SQLI`)
scoped to exclude the submission-body field specifically, via a
route-scoped ModSecurity rule exclusion (`SecRuleUpdateActionById` /
`ctl:ruleRemoveTargetByTag` in a per-location snippet), rather than disabling
those rule groups cluster-wide. Everything else (auth, billing, profile,
discussion/social endpoints) keeps the full CRS rule set at the default
paranoia level.

## Tuning / false-positive procedure

1. Any new or updated ruleset (Cloudflare managed ruleset version bump, CRS
   version bump) is rolled out in **detection/log-only mode** first, never
   directly to blocking.
2. Minimum 14-day burn-in against real production traffic, specifically
   spanning at least one contest window (the highest-adversarial-looking
   legitimate traffic: bulk code submissions, bursty rate, some circuit JSON
   payloads that can look like structured-injection attempts).
3. Logged-but-not-blocked hits are triaged by the platform team; any rule
   that fires on legitimate lab/contest submission bodies, circuit-editor
   payloads, or SSO/SAML assertions gets a scoped exclusion (never a blanket
   ruleset disable) before the rule set moves to blocking mode.
4. Once in blocking mode, a rule that produces a confirmed false positive is
   patched same-day with a scoped exclusion + regression test recorded in the
   WAF ruleset repo; it does not wait for the next scheduled ruleset review.
5. Quarterly review of block-mode false-positive rate per rule group,
   cross-referenced against the `entitlement_denial_rate` and read-latency
   dashboards in case an overly broad rule is silently rejecting legitimate
   traffic that never reaches the point of generating a support ticket.

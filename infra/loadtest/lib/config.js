// lib/config.js
//
// Central knobs shared by every scenario file (main.js, contest-burst.js,
// soak.js). Nothing in here talks to the network - it just resolves
// environment variables into typed constants so a single set of scripts can
// run against docker compose, a single cluster cell, or the full fleet.

/**
 * SCALE multiplies every arrival-rate target in the suite.
 *
 * §1 numbers (system-design.md) describe the FULL 50,000-concurrent-user
 * fleet. A single docker-compose stack is one Postgres, one Redis, one
 * quantum-kernel container - i.e. roughly one cell's worth of *one pod*, not
 * the fleet. Running SCALE=1 against compose will just prove your laptop
 * falls over; see README.md for the guidance on safe SCALE values locally.
 *
 * Default is 1 (full §1 scale) because that is the number the thresholds in
 * this suite are actually asserting against, and it's what a k6-operator run
 * against a real cell/cluster should use.
 */
export const SCALE = Number(__ENV.SCALE || '1');

if (!(SCALE > 0)) {
  throw new Error(`SCALE must be a positive number, got ${__ENV.SCALE}`);
}

// Fastify api-gateway (also hosts ws-gateway) per infra/loadtest/SPEC.md - port 3001.
export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

// WebSocket origin for the contest broadcaster (ws:contest:{id} fanout, §5/§6).
// Defaults to deriving from BASE_URL (http->ws, https->wss) so one env var
// (BASE_URL) is enough for the common case; WS_URL overrides it explicitly.
export const WS_URL = (__ENV.WS_URL || BASE_URL.replace(/^http/, 'ws')).replace(/\/+$/, '');

// quantum-kernel FastAPI service, for the soak scenario's /metrics scrape.
// Not reachable through the api-gateway path, so it needs its own base.
export const KERNEL_URL = (__ENV.KERNEL_URL || 'http://localhost:8100').replace(/\/+$/, '');

// api-gateway's Prometheus metrics port (SPEC.md: "api ... 9464 /metrics"),
// separate from BASE_URL's application port (3001) - used by soak.js's
// memory-growth watcher.
export const API_METRICS_URL = (__ENV.API_METRICS_URL || 'http://localhost:9464').replace(/\/+$/, '');

// Pre-seeded bearer token, used as the auth fallback (see lib/auth.js) when
// the dev/session login endpoint is unavailable (e.g. a locked-down staging
// environment where synthetic account creation is disabled).
export const RQ_TOKEN = __ENV.RQ_TOKEN || '';

// Tagging / provenance for results (README §"cluster runs" + REPORT-TEMPLATE.md).
export const GIT_SHA = __ENV.GIT_SHA || 'unknown-sha';
export const CELL_ID = __ENV.CELL_ID || 'cell-0';
export const RUN_ID = __ENV.RUN_ID || `${Date.now()}`;

// §4: >=92% of "editing circuits" simulations never leave the browser
// (client-side @redquant/qir statevector engine, T-A tier, <=14 qubits).
// This is a *product* constant, not a test knob - it is exported so both
// main.js's cohort-mix arithmetic and its explanatory comments derive from
// one source of truth instead of a magic 0.92 repeated in three places.
export const CLIENT_SIM_SHARE = 0.92;

// §7 entitlement ceilings, used to size synthetic circuit payloads (lib/circuits.js)
// and to make entitlement-denial responses plausible instead of arbitrary.
export const PLAN_MAX_QUBITS = {
  free: 16,
  pro: 28,
  teams: 30,
  campus: 32,
};

export function isRateLimited(res) {
  return res.status === 429;
}

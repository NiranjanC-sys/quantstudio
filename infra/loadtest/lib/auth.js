// lib/auth.js
//
// Session acquisition for synthetic load-test users.
//
// §8: sessions are an opaque 256-bit id in an HttpOnly cookie, Redis-backed.
// k6's http.* client keeps a per-VU cookie jar automatically (see
// https://k6.io/docs/javascript-api/k6-http/cookiejar/), so once a VU logs
// in successfully every subsequent http.* call from that VU carries the
// session cookie without any extra plumbing here.
//
// Real user/session provisioning (OIDC, passkeys, magic links, SAML) is out
// of scope for a load generator. We rely on a `dev-session` endpoint that
// the api-gateway is expected to expose in non-prod environments to mint a
// session for an arbitrary synthetic userId without a full auth handshake
// (mirrors how most fleets provide a load-test/seeding backdoor gated by an
// env flag). If that is unavailable - a locked-down staging/prod-like
// environment - we fall back to a pre-seeded static bearer token supplied via
// RQ_TOKEN, which an operator creates out of band (see README.md).

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, RQ_TOKEN } from './config.js';

/**
 * @typedef {{ id: string, email: string, plan: string }} SyntheticUser
 */

/**
 * Deterministically build a synthetic user identity from a numeric index so
 * that repeated runs (and repeated iterations within a run) address a stable
 * pool of "users" instead of an ever-growing one. Plan distribution is a
 * rough mirror of a real cohort: mostly free, a meaningful pro/teams slice,
 * a thin campus slice - it only needs to be plausible enough to exercise
 * §7's per-plan qubit ceilings and rate limits.
 *
 * @param {number} index
 * @returns {SyntheticUser}
 */
export function syntheticUser(index) {
  const bucket = index % 20;
  let plan = 'free';
  if (bucket >= 18) plan = 'campus'; // 2/20 = 10%
  else if (bucket >= 14) plan = 'teams'; // 4/20 = 20%
  else if (bucket >= 6) plan = 'pro'; // 8/20 = 40%
  // else free: 6/20 = 30%

  return {
    id: `loadtest-${index}`,
    email: `loadtest+${index}@rq-loadtest.invalid`,
    plan,
  };
}

/**
 * Log a synthetic user in for the current VU. Call once from a scenario's
 * exec function (or from `setup`/an init-per-VU pattern) - the cookie jar
 * then covers every subsequent request made by http.* from this VU.
 *
 * @param {SyntheticUser} user
 * @returns {{ ok: boolean, headers: Record<string,string>, viaFallbackToken: boolean }}
 */
export function login(user) {
  const res = http.post(
    `${BASE_URL}/auth/dev-session`,
    JSON.stringify({ userId: user.id, email: user.email, plan: user.plan }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'auth_dev_session' },
    },
  );

  const ok = check(res, {
    'dev-session login succeeded': (r) => r.status === 200 || r.status === 201,
  });

  if (ok) {
    // Session cookie is now in this VU's cookie jar; no headers needed.
    return { ok: true, headers: {}, viaFallbackToken: false };
  }

  if (RQ_TOKEN) {
    // Fallback: a pre-seeded token minted out of band by an operator
    // (e.g. `rq-cli tokens create --scope loadtest`) for environments where
    // the dev-session backdoor is disabled.
    return {
      ok: true,
      headers: { Authorization: `Bearer ${RQ_TOKEN}` },
      viaFallbackToken: true,
    };
  }

  return { ok: false, headers: {}, viaFallbackToken: false };
}

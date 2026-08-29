// lib/fixtures.js
//
// Loads results/fixtures.json (written by tools/seed.mjs) into a SharedArray so
// every VU reads the same pool without each one holding its own 6 MB copy.
//
// WHY PRE-SEEDED SESSIONS INSTEAD OF LOGGING IN
// --------------------------------------------
// §8 hashes passwords with Argon2id (m=64 MiB, t=3, p=4) and §9 caps auth at
// 10 requests / 10 min / IP. A generator that logged in per VU from one host
// would be rate-limited after ten VUs, and what it measured would be Argon2,
// not the platform. tools/seed.mjs writes exactly the state a real login writes
// (a Redis `sess:{sha256(token)}` record plus the session-bound `rq_csrf`
// double-submit token) and hands the cookie pair to k6.
//
// This means AUTHENTICATION IS NOT UNDER TEST in this suite. Session RESOLUTION
// is (one Redis GET + one entitlement-stamp GET on every request), because that
// is on the hot path of every authenticated call.

import { SharedArray } from 'k6/data';

const raw = JSON.parse(open('../results/fixtures.json'));

export const USERS = new SharedArray('users', () => raw.users);
export const LESSON_SLUGS = new SharedArray('lessons', () => raw.lessons);
export const GRADABLE_LESSON_IDS = new SharedArray('gradableLessons', () => raw.gradableLessonIds);
export const CONTEST = raw.contest;

/**
 * A VU IS NOT A USER.
 *
 * §1's rates are the product of a COHORT SIZE and a per-user action rate:
 * 4,000 contest entrants submitting once every 90 s is 44 rps. k6 sustains
 * 44 rps with a handful of VUs, so binding one account to one VU would put
 * §9's per-user token buckets (contest: 10/min plus a 20 s per-problem
 * cooldown) under 44 requests/second from ~10 accounts — and the run would
 * measure the limiter working correctly rather than the platform.
 *
 * Instead each cohort draws from a DISJOINT slice of the seeded pool, sized to
 * §1's own cohort count, indexed by the executor's global iteration counter. A
 * cohort therefore spreads its load across as many distinct accounts as §1 says
 * there are people in it.
 *
 * Slices (20,000 seeded accounts):
 *   contest     [    0,  4,000)   §1: 8%  = 4,000 users
 *   labs        [4,000, 10,000)   §1: 12% = 6,000 users
 *   editing     [10,000, 14,000)  §1: 22% = 11,000 users, truncated to the pool
 *   reading     [14,000, 20,000)  §1: 55% = 27,500 users, truncated to the pool
 *   dashboards  [14,000, 20,000)  §1: 3%  = 1,500 users (shares the read slice;
 *                                  both are read-class buckets at 120/10 s)
 *
 * The reading and editing slices are SMALLER than §1's cohort counts because
 * the pool is 20,000, not 50,000. That only matters if a slice's per-user rate
 * limit binds; at every rate actually run it did not (see the report's
 * rate-limit column, which is 0% for both).
 */
export const SLICES = {
  contest: [0, 4000],
  labs: [4000, 10000],
  editing: [10000, 14000],
  reading: [14000, 20000],
  dashboards: [14000, 20000],
};

export function userForIteration(cohort, iteration) {
  const [lo, hi] = SLICES[cohort];
  const width = Math.min(hi, USERS.length) - lo;
  return USERS[lo + (iteration % width)];
}

/** Kept for scenarios that genuinely want one stable account per VU. */
export function userForVU(vu) {
  return USERS[(vu - 1) % USERS.length];
}

/**
 * Request headers for an authenticated call.
 *
 * §9's limiters are per-user AND per-IP. Every request from a single k6 host
 * shares one source address, so the per-IP bucket (20x the per-user capacity,
 * i.e. 2,400 reads / 10 s = 240 rps) becomes a hard ceiling that has nothing to
 * do with the server's capacity. SPREAD_IPS=1 gives each VU a distinct
 * X-Forwarded-For (the gateway runs with `trustProxy: true`), which models
 * 50,000 users arriving from 50,000 addresses rather than one NAT.
 *
 * Both modes are reported. Neither is "the" answer: the single-IP run measures
 * the limiter, the spread run measures the stack behind it.
 */
function ipFor(user) {
  // FNV-1a over the session cookie: stable per ACCOUNT, so the per-IP bucket
  // tracks a user the way it would if each learner had their own address.
  let hash = 2166136261 >>> 0;
  const s = user.csrf;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `10.${(hash >> 16) & 255}.${(hash >> 8) & 255}.${(hash & 255) || 1}`;
}

export function authHeaders(user, _vu, extra) {
  const h = {
    Cookie: user.cookie,
    'x-csrf-token': user.csrf,
  };
  if (__ENV.SPREAD_IPS === '1') h['X-Forwarded-For'] = ipFor(user);
  if (extra) Object.assign(h, extra);
  return h;
}

/** Idempotency-Key must be 8-255 characters (routes/helpers.ts). */
export function idempotencyKey(prefix) {
  return `${prefix}-${__VU}-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

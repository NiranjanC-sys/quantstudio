// lib/checks.js
//
// Shared check() wrappers so every scenario reports into the same `checks`
// metric consistently (main.js's threshold `checks: rate > 0.99` depends on
// this being applied uniformly - a scenario that forgets to check() its
// responses would silently inflate the pass rate by omission).
//
// §9: HTTP 429 is an *expected* outcome under load (token-bucket rate
// limiting), not a bug. We never assert "status === 200" as the only good
// outcome - a 429 counts as a structurally correct response (the server
// behaved exactly as designed) and is tracked separately via a Rate metric
// rather than failing the check.

import { check } from 'k6';

/**
 * @param {import('k6/http').RefinedResponse<any>} res
 * @param {number[]} okStatuses - statuses that count as a fully successful outcome
 * @param {string} name - check label, shown in the summary
 */
export function checkOk(res, okStatuses, name) {
  return check(
    res,
    {
      [`${name}: status is one of ${okStatuses.join(',')} or 429 (rate-limited)`]: (r) =>
        okStatuses.includes(r.status) || r.status === 429,
    },
    { name },
  );
}

/**
 * Strict variant for calls that must never be legitimately rate-limited in
 * this suite (e.g. the leaderboard read used for the monotonicity assertion
 * in contest-burst.js - a 429 there would corrupt the rank history rather
 * than represent a benign shed request).
 */
export function checkStrict(res, okStatuses, name) {
  return check(
    res,
    {
      [`${name}: status is one of ${okStatuses.join(',')}`]: (r) => okStatuses.includes(r.status),
    },
    { name },
  );
}

/**
 * @param {import('k6/http').RefinedResponse<any>} res
 */
export function checkJsonBody(res, name) {
  return check(
    res,
    {
      [`${name}: body parses as JSON`]: (r) => {
        try {
          r.json();
          return true;
        } catch (_e) {
          return false;
        }
      },
    },
    { name },
  );
}

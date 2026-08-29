// lib/prng.js
//
// Tiny deterministic PRNGs shared by contest-burst.js and soak.js. Nothing
// cryptographic - just "same seed in -> same sequence out", which is the
// entire point: contest-burst.js's submission plan must be a pure function
// of a seed so it can be independently regenerated (in handleSummary, or by
// a human debugging a failed run) without needing to collect anything from
// the isolated-memory VUs that actually sent the requests.

/** Mulberry32: fast, tiny, good-enough statistical quality for load-test
 * fixtures. Returns a function that yields floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, used to turn a human-readable seed (e.g. a contest
 * slug or a git sha) into a numeric seed for mulberry32. */
export function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

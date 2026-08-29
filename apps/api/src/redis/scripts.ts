/**
 * The Lua scripts that carry the correctness-critical Redis logic.
 *
 * They exist because the alternative — read, decide, write from Node — is a
 * read-modify-write across a network, and system-design §6 is explicit that
 * concurrent graders must not be able to interleave.
 */
import type { Redis } from 'ioredis';

/**
 * Contest scoring (system-design §6, step 3).
 *
 * `SETNX solved:{contest}:{user}:{problem}` is the first-accept guard; the
 * `ZINCRBY lb:{contest}` only runs if the SETNX wins. Both keys carry the same
 * `{contest}` hash tag, so they live in one Redis Cluster slot and the script is
 * legal on a cluster. The consequence is exactly what §6 claims: the script is
 * idempotent under at-least-once delivery, and the board is monotone because a
 * score is only ever incremented, once per (user, problem).
 *
 * Score packing (§5): `points * 2^32 - penalty_seconds`. Points dominate;
 * penalty breaks ties in favour of the faster solve. Both terms stay well inside
 * the 53-bit integer range of a ZSET double.
 *
 * KEYS: solved marker, leaderboard, per-user solve detail, per-problem attempts.
 * ARGV: member, points, elapsedSeconds, penaltyPerReject, problemId, ttlSeconds.
 * Returns: `[firstAccept (1|0), score, penaltyApplied]`.
 */
export const CONTEST_SCORE_LUA = `
local solvedKey   = KEYS[1]
local boardKey    = KEYS[2]
local detailKey   = KEYS[3]
local attemptsKey = KEYS[4]

local member     = ARGV[1]
local points     = tonumber(ARGV[2])
local elapsed    = tonumber(ARGV[3])
local penaltyPer = tonumber(ARGV[4])
local problemId  = ARGV[5]
local ttl        = tonumber(ARGV[6])

-- First-accept guard. A retried delivery of the same accepted submission, or a
-- second accepted submission for the same (user, problem), stops here.
if redis.call('SETNX', solvedKey, elapsed) == 0 then
  local existing = redis.call('ZSCORE', boardKey, member)
  return { 0, existing or '0', '0' }
end

if ttl > 0 then
  redis.call('EXPIRE', solvedKey, ttl)
end

local rejected = tonumber(redis.call('GET', attemptsKey) or '0')
local penalty  = elapsed + rejected * penaltyPer
local delta    = points * 4294967296 - penalty

local score = redis.call('ZINCRBY', boardKey, delta, member)
redis.call('HSET', detailKey, problemId, elapsed .. ':' .. rejected .. ':' .. points)

if ttl > 0 then
  redis.call('EXPIRE', boardKey, ttl)
  redis.call('EXPIRE', detailKey, ttl)
end

return { 1, score, tostring(penalty) }
`;

/**
 * Records a rejected attempt. ICPC semantics: attempts made after the problem is
 * solved carry no penalty, so the counter stops once the solved marker exists.
 *
 * KEYS: solved marker, attempts counter. ARGV: ttlSeconds.
 * Returns the attempt count that will be charged on a future accept.
 */
export const CONTEST_REJECT_LUA = `
local solvedKey   = KEYS[1]
local attemptsKey = KEYS[2]
local ttl         = tonumber(ARGV[1])

if redis.call('EXISTS', solvedKey) == 1 then
  return tonumber(redis.call('GET', attemptsKey) or '0')
end

local n = redis.call('INCR', attemptsKey)
if ttl > 0 then
  redis.call('EXPIRE', attemptsKey, ttl)
end
return n
`;

/**
 * Token bucket (system-design §9). Lazy refill: the bucket stores its level and
 * the timestamp it was last observed, and refills on read. One HGETALL-free
 * round trip, O(1) memory per bucket, and no background sweeper.
 *
 * KEYS: bucket. ARGV: capacity, refillPerSecond, nowMs, cost, ttlSeconds.
 * Returns: `[allowed (1|0), remainingTokens, retryAfterMs, resetMs]`.
 */
export const TOKEN_BUCKET_LUA = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local cost       = tonumber(ARGV[4])
local ttl        = tonumber(ARGV[5])

local state  = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refillRate)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 't', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)

local retryAfterMs = 0
if allowed == 0 then
  retryAfterMs = math.ceil(((cost - tokens) / refillRate) * 1000)
end
local resetMs = math.ceil(((capacity - tokens) / refillRate) * 1000)

return { allowed, math.floor(tokens), retryAfterMs, resetMs }
`;

/**
 * Idempotency-Key reservation (system-design §9). Either this caller wins the
 * key and must go on to execute the request, or it loses and gets back whatever
 * the winner stored — including the marker that says the winner is still running.
 *
 * KEYS: idempotency record. ARGV: requestFingerprint, ttlSeconds.
 * Returns: `[state, payload]` where state is `new` | `in_flight` | `replay` |
 * `mismatch`.
 */
export const IDEMPOTENCY_BEGIN_LUA = `
local key         = KEYS[1]
local fingerprint = ARGV[1]
local ttl         = tonumber(ARGV[2])

local existing = redis.call('HMGET', key, 'fp', 'state', 'body')
if existing[1] == false or existing[1] == nil then
  redis.call('HSET', key, 'fp', fingerprint, 'state', 'in_flight')
  redis.call('EXPIRE', key, ttl)
  return { 'new', '' }
end

if existing[1] ~= fingerprint then
  return { 'mismatch', '' }
end

if existing[2] == 'done' then
  return { 'replay', existing[3] or '' }
end

return { 'in_flight', '' }
`;

/**
 * Read-your-own-writes (system-design §5). A write stamps the user's LSN key
 * with a short TTL; reads inside that window are routed to the primary. Storing
 * the deadline rather than a duration keeps the check a single GET.
 *
 * KEYS: write marker. ARGV: nowMs, windowMs.
 * Returns 1 when the marker is live.
 */
export const WRITE_MARKER_CHECK_LUA = `
local key   = KEYS[1]
local now   = tonumber(ARGV[1])
local until_ = tonumber(redis.call('GET', key) or '0')
if until_ > now then
  return 1
end
return 0
`;

export interface ScriptRunner {
  contestScore(
    keys: [solved: string, board: string, detail: string, attempts: string],
    argv: [member: string, points: number, elapsed: number, penaltyPer: number, problemId: string, ttl: number],
  ): Promise<[firstAccept: number, score: string, penalty: string]>;
  contestReject(keys: [solved: string, attempts: string], ttlSeconds: number): Promise<number>;
  tokenBucket(
    key: string,
    capacity: number,
    refillPerSecond: number,
    nowMs: number,
    cost: number,
    ttlSeconds: number,
  ): Promise<[allowed: number, remaining: number, retryAfterMs: number, resetMs: number]>;
  idempotencyBegin(
    key: string,
    fingerprint: string,
    ttlSeconds: number,
  ): Promise<[state: string, payload: string]>;
  writeMarkerLive(key: string, nowMs: number): Promise<boolean>;
}

interface RedisWithScripts extends Redis {
  rqContestScore(...args: (string | number)[]): Promise<[number, string, string]>;
  rqContestReject(...args: (string | number)[]): Promise<number>;
  rqTokenBucket(...args: (string | number)[]): Promise<[number, number, number, number]>;
  rqIdempotencyBegin(...args: (string | number)[]): Promise<[string, string]>;
  rqWriteMarker(...args: (string | number)[]): Promise<number>;
}

/**
 * Registers every script with ioredis, which uses EVALSHA and falls back to EVAL
 * exactly once after a Redis restart flushes the script cache.
 */
export function createScriptRunner(redis: Redis): ScriptRunner {
  const r = redis as RedisWithScripts;

  r.defineCommand('rqContestScore', { numberOfKeys: 4, lua: CONTEST_SCORE_LUA });
  r.defineCommand('rqContestReject', { numberOfKeys: 2, lua: CONTEST_REJECT_LUA });
  r.defineCommand('rqTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  r.defineCommand('rqIdempotencyBegin', { numberOfKeys: 1, lua: IDEMPOTENCY_BEGIN_LUA });
  r.defineCommand('rqWriteMarker', { numberOfKeys: 1, lua: WRITE_MARKER_CHECK_LUA });

  return {
    contestScore: (keys, argv) => r.rqContestScore(...keys, ...argv),
    contestReject: (keys, ttlSeconds) => r.rqContestReject(...keys, ttlSeconds),
    tokenBucket: (key, capacity, refillPerSecond, nowMs, cost, ttlSeconds) =>
      r.rqTokenBucket(key, capacity, refillPerSecond, nowMs, cost, ttlSeconds),
    idempotencyBegin: (key, fingerprint, ttlSeconds) =>
      r.rqIdempotencyBegin(key, fingerprint, ttlSeconds),
    writeMarkerLive: async (key, nowMs) => (await r.rqWriteMarker(key, nowMs)) === 1,
  };
}

/** Canonical Redis key names, in one place so the Lua slot tags stay consistent. */
export const keys = {
  session: (sid: string) => `sess:${sid}`,
  userSessions: (userId: string) => `sess:user:${userId}`,
  leaderboard: (contestId: string) => `lb:{${contestId}}`,
  solved: (contestId: string, userId: string, problemId: string) =>
    `solved:{${contestId}}:${userId}:${problemId}`,
  solveDetail: (contestId: string, userId: string) => `sv:{${contestId}}:${userId}`,
  attempts: (contestId: string, userId: string, problemId: string) =>
    `att:{${contestId}}:${userId}:${problemId}`,
  contestFrozen: (contestId: string) => `frozen:{${contestId}}`,
  problemCooldown: (contestId: string, userId: string, problemId: string) =>
    `cd:{${contestId}}:${userId}:${problemId}`,
  globalLeaderboard: () => 'lb:global',
  institutionLeaderboard: (orgId: string) => `lb:org:${orgId}`,
  rateLimit: (bucket: string) => `rl:${bucket}`,
  idempotency: (userId: string, key: string) => `idem:${userId}:${key}`,
  writeMarker: (userId: string) => `wlsn:${userId}`,
  simCache: (hash: string) => `sim:${hash}`,
  presence: (lessonId: number) => `presence:${lessonId}`,
  tutorTokens: (userId: string, day: string) => `tutor:tok:${userId}:${day}`,
  tutorMessages: (userId: string, day: string) => `tutor:msg:${userId}:${day}`,
  tutorHourlyCost: (hour: string) => `tutor:cost:${hour}`,
  entitlementCache: (userId: string) => `ent:${userId}`,
  catalogCache: (name: string) => `cat:${name}`,
  oauthState: (state: string) => `oauth:${state}`,
  webauthnChallenge: (kind: string, id: string) => `wa:${kind}:${id}`,
  samlRequest: (id: string) => `saml:req:${id}`,
  samlReplay: (assertionId: string) => `saml:seen:${assertionId}`,
  wsContest: (contestId: string) => `ws:contest:${contestId}`,
  wsUser: (userId: string) => `ws:user:${userId}`,
} as const;

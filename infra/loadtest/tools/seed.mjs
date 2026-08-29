/**
 * seed.mjs — provision load-test fixtures directly against Postgres + Redis.
 *
 * WHY NOT LOG IN THROUGH THE API?
 *   §8 makes passwords Argon2id (m=64 MiB, t=3, p=4) and §9 caps auth at
 *   10 requests / 10 min / IP. A load generator that authenticates per VU
 *   would (a) be rate-limited into uselessness from a single host and
 *   (b) measure password hashing rather than the platform. Real fleets
 *   pre-seed load-test sessions; that is what this does.
 *
 * It writes exactly the state the gateway would have written on a real login:
 *   - identity.users row
 *   - progress.mastery / progress.streaks / billing.credit_balances rows
 *   - a Redis `sess:{sha256(token)}` record matching auth/types.ts SessionRecord
 *   - an `rq_csrf` value = issueCsrfToken(CSRF_SECRET, sha256(token)), i.e.
 *     `nonce.HMAC-SHA256(CSRF_SECRET, "nonce|sha256(token)")` — identical to
 *     middleware/security.ts.
 *
 * entitlementStamp is deliberately left stale ('seed'), so the gateway's own
 * entitlement service resolves and patches the session on that user's first
 * request. Nothing here reimplements the entitlement matrix.
 *
 * Output: results/fixtures.json — consumed by main.js / contest-burst.js.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results');

const USERS = Number(process.env.SEED_USERS || '2000');
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://redquant_dev:redquant-dev-only-pw@127.0.0.1:5432/redquant';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CSRF_SECRET = process.env.CSRF_SECRET || 'dev-only-csrf-secret-change-me-0000000000';
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 1209600);
/** Credits are §7-metered; a load run would exhaust a real balance in seconds.
 *  We grant a deliberately huge balance so CREDITS are not the thing measured. */
const CREDIT_GRANT = Number(process.env.SEED_CREDITS || '2000000000');

const CONTEST_SLUG = process.env.CONTEST_SLUG || 'loadtest-burst-contest';
const PROBLEM_LABELS = ['A', 'B', 'C', 'D', 'E'];
const PROBLEM_POINTS = { A: 100, B: 200, C: 300, D: 400, E: 500 };
const PENALTY_PER_REJECT = 1200;

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const hmacHex = (secret, s) => createHmac('sha256', secret).update(s).digest('hex');
function issueCsrfToken(secret, sessionKey) {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${hmacHex(secret, `${nonce}|${sessionKey}`)}`;
}

/** Plan mix, mirroring lib/auth.js's cohort: 30% free, 40% pro, 20% teams, 10% campus. */
function planFor(i) {
  const b = i % 20;
  if (b >= 18) return 'campus';
  if (b >= 14) return 'teams';
  if (b >= 6) return 'pro';
  return 'free';
}

const client = new pg.Client({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL);

await client.connect();
console.log(`[seed] ${USERS} users -> ${DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);

// -------------------------------------------------------------------- users
// Users are REUSED across runs, never deleted: billing.credit_ledger carries an
// append-only trigger, so DELETE FROM identity.users fails on cascade. Re-running
// the seed therefore re-mints sessions for the same stable user pool.
const t0 = Date.now();
const existing = await client.query(
  `SELECT id, email FROM identity.users WHERE email LIKE 'loadtest+%@rq-loadtest.invalid'`,
);
const byEmail = new Map(existing.rows.map((r) => [r.email, r.id]));
const fixtures = [];
const fresh = [];
for (let i = 0; i < USERS; i++) {
  const email = `loadtest+${i}@rq-loadtest.invalid`;
  const known = byEmail.get(email);
  const id = known ?? randomUUID();
  fixtures.push({ index: i, id, plan: planFor(i) });
  if (!known) fresh.push({ i, id, email });
}
const BATCH = 500;
for (let start = 0; start < fresh.length; start += BATCH) {
  const chunk = fresh.slice(start, start + BATCH);
  const rows = [];
  const params = [];
  let p = 1;
  for (const f of chunk) {
    rows.push(`($${p++},$${p++},true,$${p++},$${p++},'learner','active',false,1,'en','UTC',now(),now())`);
    params.push(f.id, f.email, `Loadtest ${f.i}`, `lt-${f.i}-${f.id.slice(0, 8)}`);
  }
  await client.query(
    `INSERT INTO identity.users
       (id,email,email_verified,display_name,handle,role,status,mfa_enrolled,privilege_version,locale,timezone,created_at,updated_at)
     VALUES ${rows.join(',')}`,
    params,
  );
}
console.log(`[seed] ${fresh.length} new users inserted, ${fixtures.length - fresh.length} reused (${Date.now() - t0} ms)`);

// --------------------------------- per-user provisioning rows (§7 / service.ts)
const ids = fixtures.map((f) => f.id);
await client.query(`INSERT INTO progress.mastery (user_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`, [ids]);
await client.query(`INSERT INTO progress.streaks (user_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`, [ids]);
await client.query(
  `INSERT INTO billing.credit_balances (user_id,balance,period_start,period_end,granted_this_period,consumed_this_period,updated_at)
   SELECT unnest($1::uuid[]), $2, now(), now() + interval '90 days', $2, 0, now()
   ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
  [ids, CREDIT_GRANT],
);

// Subscriptions, so the §7 plan ceilings (free 16 / pro 28 / teams 30 / campus 32)
// are actually exercised rather than every synthetic user being free-tier.
for (const plan of ['pro', 'teams', 'campus']) {
  const subset = fixtures.filter((f) => f.plan === plan).map((f) => f.id);
  if (!subset.length) continue;
  await client.query(
    `INSERT INTO billing.subscriptions (id,user_id,plan_code,status,seats,current_period_end,cancel_at_period_end,created_at,updated_at)
     SELECT gen_random_uuid(), unnest($1::uuid[]), $2, 'active', 1, now() + interval '90 days', false, now(), now()
     ON CONFLICT DO NOTHING`,
    [subset, plan],
  );
}
console.log('[seed] provisioning rows + subscriptions done');

// ------------------------------------------------------------------ sessions
const now = Date.now();
const pipeline = redis.pipeline();
for (const f of fixtures) {
  const token = randomBytes(32).toString('base64url');
  const sessionKey = sha256Hex(token);
  const record = {
    userId: f.id,
    email: `loadtest+${f.index}@rq-loadtest.invalid`,
    handle: `lt-${f.index}`,
    role: 'learner',
    orgId: null,
    orgRole: null,
    amr: ['pwd'],
    mfaSatisfied: false,
    privilegeVersion: 1,
    plan: f.plan,
    // Deliberately stale: the gateway resolves the real snapshot on first use.
    entitlements: { plan: f.plan },
    entitlementStamp: 'seed',
    ipHash: null,
    uaHash: null,
    createdAtMs: now,
    expiresAtMs: now + SESSION_TTL_SECONDS * 1000,
  };
  pipeline.set(`sess:${sessionKey}`, JSON.stringify(record), 'EX', SESSION_TTL_SECONDS);
  f.session = token;
  f.csrf = issueCsrfToken(CSRF_SECRET, sessionKey);
  f.cookie = `rq_session=${token}; rq_csrf=${f.csrf}`;
}
await pipeline.exec();
console.log(`[seed] ${fixtures.length} redis sessions written`);

// ------------------------------------------------------------------- contest
await client.query(`DELETE FROM contest.contests WHERE slug = $1`, [CONTEST_SLUG]);
const contestId = randomUUID();
// Window: started 10 min ago, ends in 6 h, freeze 60 min before the end — so the
// board is LIVE (not frozen) for the whole burst, which is what §6 asks us to test.
await client.query(
  `INSERT INTO contest.contests
     (id,slug,title,kind,status,starts_at,ends_at,freeze_minutes,penalty_seconds_per_reject,virtual_allowed,created_at,updated_at)
   VALUES ($1,$2,'Load-test burst contest','rated','running',
           now() - interval '10 minutes', now() + interval '6 hours', 60, $3, false, now(), now())`,
  [contestId, CONTEST_SLUG, PENALTY_PER_REJECT],
);
const problems = [];
for (let i = 0; i < PROBLEM_LABELS.length; i++) {
  const label = PROBLEM_LABELS[i];
  const pid = randomUUID();
  await client.query(
    `INSERT INTO contest.problems
       (id,contest_id,label,slug,title,statement,points,time_limit_ms,memory_mb,max_qubits,grader_key,opens_at,position)
     VALUES ($1,$2,$3,$4,$5,'Load-test problem.',$6,2000,512,16,'loadtest-echo',
             now() - interval '10 minutes',$7)`,
    [pid, contestId, label, `${CONTEST_SLUG}-${label.toLowerCase()}`, `Problem ${label}`, PROBLEM_POINTS[label], i + 1],
  );
  problems.push({ label, id: pid, points: PROBLEM_POINTS[label] });
}
await client.query(
  `INSERT INTO contest.registrations (contest_id,user_id,kind,rated,registered_at)
   SELECT $1, unnest($2::uuid[]), 'live', true, now() ON CONFLICT DO NOTHING`,
  [contestId, ids],
);
console.log(`[seed] contest ${CONTEST_SLUG} (${contestId}) with ${problems.length} problems, ${ids.length} registrations`);

// Clear any leaderboard state from a previous run so standings start empty.
const stale = await redis.keys(`*{${contestId}}*`);
if (stale.length) await redis.del(stale);

// --------------------------------------------------------------- lesson pool
const lessonRows = await client.query(
  `SELECT l.slug, l.id, l.grader_key IS NOT NULL AS gradable
     FROM catalog.lessons l ORDER BY l.id`,
);
const lessons = lessonRows.rows.map((r) => r.slug);
const gradableLessonIds = lessonRows.rows.filter((r) => r.gradable).map((r) => r.id);

mkdirSync(RESULTS, { recursive: true });
const out = {
  generatedAt: new Date().toISOString(),
  users: fixtures.map((f) => ({ id: f.id, plan: f.plan, cookie: f.cookie, csrf: f.csrf })),
  lessons,
  gradableLessonIds,
  contest: { id: contestId, slug: CONTEST_SLUG, problems, penaltySecondsPerReject: PENALTY_PER_REJECT },
};
writeFileSync(join(RESULTS, 'fixtures.json'), JSON.stringify(out));
console.log(`[seed] wrote results/fixtures.json (${fixtures.length} users, ${lessons.length} lessons, ${gradableLessonIds.length} gradable)`);

await client.end();
redis.disconnect();

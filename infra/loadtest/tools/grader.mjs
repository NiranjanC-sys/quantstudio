/**
 * grader.mjs — the missing grader worker, for load-test purposes only.
 *
 * §6 step 2 says "Grader workers (KEDA-scaled on queue depth) pull, execute in a
 * sandbox, and write submission_results". No such service exists in this repo:
 * `POST /contests/:id/submit` enqueues onto the BullMQ `grade` queue and nothing
 * consumes it, so without this process the leaderboard never moves and §6's
 * correctness properties cannot be observed at all.
 *
 * This worker does NOT sandbox anything. It implements the `loadtest-echo`
 * grader contract only: a submission is ACCEPTED iff its source contains the
 * literal marker `#LOADTEST_ACCEPT`, otherwise `wrong_answer`. That makes the
 * expected final standings a pure function of the submission log, which is what
 * the replay check in tools/replay-check.mjs needs.
 *
 * Everything correctness-critical (SETNX + ZINCRBY Lua, penalty arithmetic,
 * monotonicity) still happens inside the gateway — this only delivers verdicts.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { SignJWT, importPKCS8 } from 'jose';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results');
mkdirSync(RESULTS, { recursive: true });

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CONCURRENCY = Number(process.env.GRADER_CONCURRENCY || '64');
const ISSUER = process.env.SERVICE_JWT_ISSUER || 'https://api.redquant.io';
const AUDIENCE = 'grader';
const LOG = join(RESULTS, 'grader-verdicts.jsonl');

const key = JSON.parse(readFileSync(join(RESULTS, 'service-key.json'), 'utf8'));
const privateKey = await importPKCS8(key.privateKey, 'EdDSA');
const fixtures = JSON.parse(readFileSync(join(RESULTS, 'fixtures.json'), 'utf8'));
const contestSlug = fixtures.contest.slug;
// The service token acts on behalf of *a* real user; middleware/auth.ts requires
// `sub` to resolve to an active account. Any load-test account will do.
const ACT_AS = fixtures.users[0].id;

async function mintToken() {
  return new SignJWT({ cell: 'cell-0', scope: ['contest:verdict'], act: 'api-gateway' })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(ACT_AS)
    .setExpirationTime('300s')
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

let token = await mintToken();
let tokenMintedAt = Date.now();
async function currentToken() {
  if (Date.now() - tokenMintedAt > 200_000) {
    token = await mintToken();
    tokenMintedAt = Date.now();
  }
  return token;
}

const stats = { graded: 0, accepted: 0, rejected: 0, errors: 0, scored: 0, duplicate: 0 };
const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(
  'grade',
  async (job) => {
    const data = job.data;
    if (data.kind !== 'contest') return;
    const verdict = data.source.includes('#LOADTEST_ACCEPT') ? 'accepted' : 'wrong_answer';
    const res = await fetch(`${BASE_URL}/contests/${contestSlug}/verdict`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await currentToken()}`,
      },
      body: JSON.stringify({ submissionId: data.submissionId, verdict, runtimeMs: 5 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      stats.errors++;
      appendFileSync(LOG, JSON.stringify({ t: Date.now(), submissionId: data.submissionId, status: res.status, body }) + '\n');
      throw new Error(`verdict ${res.status}: ${JSON.stringify(body)}`);
    }
    stats.graded++;
    if (verdict === 'accepted') stats.accepted++; else stats.rejected++;
    if (body.scored) stats.scored++;
    if (body.duplicate) stats.duplicate++;
    appendFileSync(
      LOG,
      JSON.stringify({
        t: Date.now(),
        submissionId: data.submissionId,
        userId: data.userId,
        problemId: data.problemId,
        elapsedSeconds: data.elapsedSeconds,
        verdict,
        scored: body.scored,
        points: body.points,
        penaltySeconds: body.penaltySeconds,
      }) + '\n',
    );
  },
  { connection, prefix: 'bull', concurrency: CONCURRENCY },
);

worker.on('failed', (_job, err) => {
  stats.errors++;
  if (stats.errors % 50 === 1) console.error('[grader] failed:', err?.message);
});

const timer = setInterval(() => {
  console.log(`[grader] ${JSON.stringify(stats)}`);
}, 5000);

async function shutdown() {
  clearInterval(timer);
  console.log(`[grader] final ${JSON.stringify(stats)}`);
  await worker.close();
  connection.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`[grader] consuming queue "grade" (prefix bull), concurrency ${CONCURRENCY}, contest ${contestSlug}`);

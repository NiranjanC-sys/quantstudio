/**
 * End-to-end gateway behaviour, against a real Postgres and a real Redis.
 *
 * These are the assertions that only hold if the whole stack is wired: that a
 * registration provisions every per-user row the rest of the product assumes,
 * that entitlements actually gate the catalogue, that completing a lesson moves
 * the materialised DAG frontier (§5), that `Idempotency-Key` replays rather than
 * re-executes (§9), that a Stripe webhook is idempotent on `stripe_event_id`
 * (§7), and that the tutor refuses to hint during a rated contest (§6).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/env.js';
import { contests, problems, registrations } from '../../src/db/schema/contest.js';
import { lessons } from '../../src/db/schema/catalog.js';
import { users } from '../../src/db/schema/identity.js';
import { stripeEvents } from '../../src/db/schema/billing.js';
import { seed } from '../../src/db/seed.js';
import { HAS_POSTGRES, HAS_REDIS, requireDatabaseUrl, requireRedisUrl } from '../support/environment.js';

const skip = !HAS_POSTGRES || !HAS_REDIS;
if (skip) {
  process.stderr.write(
    '[gateway.test] Postgres and/or Redis are not available; the gateway suite is SKIPPED.\n',
  );
}

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

describe.skipIf(skip)('gateway', () => {
  let built: BuiltApp;
  let env: Env;

  beforeAll(async () => {
    env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: requireDatabaseUrl(),
      REDIS_URL: requireRedisUrl(),
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'silent',
      METRICS_ENABLED: 'true',
      RATE_LIMIT_ENABLED: 'true',
      // A fake key is enough: the webhook test verifies a locally signed payload
      // and the handler it exercises never calls out to Stripe.
      STRIPE_SECRET_KEY: 'sk_test_redquant_integration',
      STRIPE_WEBHOOK_SECRET: 'whsec_redquant_integration',
      EMAIL_TRANSPORT: 'console',
    });

    built = await buildApp(env);
    await seed(built.services.db.primary, env);
  }, 180_000);

  afterAll(async () => {
    if (built) await built.close();
  });

  let ipCounter = 0;

  /**
   * Registers a throwaway learner and returns everything needed to act as them.
   *
   * Each registration is attributed to its own client address. §9 limits auth to
   * "10 / 10 min / IP" and the limiter stays *enabled* for this suite, so
   * sharing one address across thirty tests would (correctly) start returning
   * 429s. `trustProxy` is on, which is what makes the header authoritative.
   */
  async function register(suffix: string): Promise<Session> {
    ipCounter += 1;
    const response = await built.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-forwarded-for': `203.0.113.${ipCounter % 250}` },
      payload: {
        email: `it-${suffix}-${Date.now()}-${ipCounter}@example.com`,
        password: 'correct-horse-battery-staple',
        displayName: `Integration ${suffix}`,
      },
    });

    expect(response.statusCode).toBe(201);

    const setCookies = response.headers['set-cookie'];
    const jar = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
    const pairs = jar.map((entry) => entry.split(';')[0] as string);
    const csrfPair = pairs.find((pair) => pair.startsWith(`${env.CSRF_COOKIE_NAME}=`));

    return {
      cookie: pairs.join('; '),
      csrf: decodeURIComponent((csrfPair ?? '').split('=').slice(1).join('=')),
      userId: (response.json() as { user: { id: string } }).user.id,
    };
  }

  function authHeaders(session: Session, extra: Record<string, string> = {}) {
    return { cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra };
  }

  describe('health', () => {
    it('answers /healthz from the process alone', async () => {
      const response = await built.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', service: 'api-gateway' });
    });

    it('checks dependencies on /readyz', async () => {
      const response = await built.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        status: string;
        checks: { database: { ok: boolean }; redis: { ok: boolean } };
      };
      expect(body.checks.database.ok).toBe(true);
      expect(body.checks.redis.ok).toBe(true);
    });

    it('exposes Prometheus metrics', async () => {
      const response = await built.app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('http_requests_total');
    });
  });

  describe('errors', () => {
    it('returns problem+json for an unknown route', async () => {
      const response = await built.app.inject({ method: 'GET', url: '/no-such-thing' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({
        type: 'https://redquant.io/problems/not-found',
        code: 'not-found',
        status: 404,
      });
    });

    it('returns a field-level problem for an invalid body', async () => {
      const response = await built.app.inject({
        method: 'POST',
        url: '/auth/register',
        headers: { 'x-forwarded-for': '198.51.100.10' },
        payload: { email: 'not-an-email' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as { code: string; errors: Array<{ path: string }> };
      expect(body.code).toBe('validation-failed');
      expect(body.errors.map((issue) => issue.path)).toContain('email');
    });

    it('requires a session for an authenticated route', async () => {
      const response = await built.app.inject({ method: 'GET', url: '/progress/overview' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'unauthorized' });
    });
  });

  describe('auth', () => {
    it('registers, provisions and resolves a session', async () => {
      const session = await register('session');

      const response = await built.app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: session.cookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        authenticated: boolean;
        plan: string;
        entitlements: { maxQubits: number };
      };
      expect(body.authenticated).toBe(true);
      expect(body.plan).toBe('free');
      expect(body.entitlements.maxQubits).toBe(16);

      // provisionNewUser must have created the rows the rest of the app assumes.
      const overview = await built.app.inject({
        method: 'GET',
        url: '/progress/overview',
        headers: { cookie: session.cookie },
      });
      expect(overview.statusCode).toBe(200);
      expect(overview.json()).toMatchObject({ xp: { total: 0 } });
    });

    it('rejects a bad password without disclosing whether the account exists', async () => {
      const response = await built.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': '198.51.100.11' },
        payload: { email: 'nobody@example.com', password: 'whatever-not-right' },
      });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { detail: string }).detail).toBe(
        'Email or password is incorrect.',
      );
    });

    it('rejects a cookie-authenticated mutation without a CSRF token', async () => {
      const session = await register('csrf');
      const response = await built.app.inject({
        method: 'POST',
        url: '/progress/enrollments',
        headers: { cookie: session.cookie },
        payload: { trackCode: 'T0' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'forbidden' });
    });

    it('signs the user out', async () => {
      const session = await register('logout');
      const logout = await built.app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: authHeaders(session),
      });
      expect(logout.statusCode).toBe(204);

      const after = await built.app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: session.cookie },
      });
      expect(after.json()).toMatchObject({ authenticated: false });
    });
  });

  describe('catalog', () => {
    it('lists the eight seeded tracks and marks what the plan can read', async () => {
      const session = await register('catalog');
      const response = await built.app.inject({
        method: 'GET',
        url: '/catalog/tracks',
        headers: { cookie: session.cookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        items: Array<{ code: string; readable: boolean }>;
      };
      expect(body.items).toHaveLength(8);
      expect(body.items.map((track) => track.code)).toEqual([
        'T0',
        'T1',
        'T2',
        'T3',
        'T4',
        'T5',
        'T6',
        'T7',
      ]);

      // §7: Free reads T0-T1 and nothing else.
      const byCode = new Map(body.items.map((track) => [track.code, track.readable]));
      expect(byCode.get('T0')).toBe(true);
      expect(byCode.get('T1')).toBe(true);
      expect(byCode.get('T2')).toBe(false);
    });

    it('hides the lesson body of a track the plan does not include', async () => {
      const session = await register('gating');
      const locked = await built.app.inject({
        method: 'GET',
        url: '/catalog/lessons/t2-m1-oracles-and-how-to-build-one',
        headers: { cookie: session.cookie },
      });

      expect(locked.statusCode).toBe(200);
      const body = locked.json() as { readable: boolean; lesson: { mdxPath: string | null } };
      expect(body.readable).toBe(false);
      expect(body.lesson.mdxPath).toBeNull();
    });

    it('serves the concept DAG and full-text search', async () => {
      const graph = await built.app.inject({ method: 'GET', url: '/catalog/concepts' });
      expect(graph.statusCode).toBe(200);
      const graphBody = graph.json() as { nodes: unknown[]; edges: unknown[] };
      expect(graphBody.nodes.length).toBeGreaterThan(0);
      expect(graphBody.edges.length).toBeGreaterThan(0);

      const search = await built.app.inject({
        method: 'GET',
        url: '/catalog/search?q=entanglement',
      });
      expect(search.statusCode).toBe(200);
      expect((search.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
    });

    it('caps the interview bank at the plan allowance', async () => {
      const session = await register('bank');
      const response = await built.app.inject({
        method: 'GET',
        url: '/catalog/questions?limit=100',
        headers: { cookie: session.cookie },
      });

      const body = response.json() as { allowance: number; items: Array<{ position: number }> };
      expect(body.allowance).toBe(20);
      expect(Math.max(...body.items.map((item) => item.position))).toBeLessThanOrEqual(20);
    });
  });

  describe('progress and the DAG', () => {
    it('completes a lesson and moves the materialised frontier', async () => {
      const session = await register('dag');

      const next = await built.app.inject({
        method: 'GET',
        url: '/progress/next',
        headers: { cookie: session.cookie },
      });
      expect(next.statusCode).toBe(200);
      const firstLesson = (next.json() as { items: Array<{ id: number; slug: string }> }).items[0];
      expect(firstLesson).toBeDefined();

      const before = await built.app.inject({
        method: 'GET',
        url: '/progress/mastery',
        headers: { cookie: session.cookie },
      });
      const beforeBody = before.json() as {
        unlockedLessonIds: number[];
        completedLessonIds: number[];
      };
      expect(beforeBody.completedLessonIds).toEqual([]);
      expect(beforeBody.unlockedLessonIds).toContain(firstLesson?.id);

      const complete = await built.app.inject({
        method: 'POST',
        url: `/progress/lessons/${firstLesson?.id}/complete`,
        headers: authHeaders(session),
        payload: { score: 1, secondsSpent: 600 },
      });

      expect(complete.statusCode).toBe(200);
      const result = complete.json() as {
        status: string;
        xpAwarded: number;
        newlyUnlocked: number[];
        streak: { current: number };
        reviewDueAt: string | null;
      };
      expect(result.status).toBe('completed');
      expect(result.xpAwarded).toBeGreaterThan(0);
      // The lesson that came after it in the DAG is now open.
      expect(result.newlyUnlocked.length).toBeGreaterThan(0);
      expect(result.streak.current).toBe(1);
      expect(result.reviewDueAt).not.toBeNull();

      const after = await built.app.inject({
        method: 'GET',
        url: '/progress/mastery',
        headers: { cookie: session.cookie },
      });
      const afterBody = after.json() as {
        unlockedLessonIds: number[];
        completedLessonIds: number[];
      };
      expect(afterBody.completedLessonIds).toContain(firstLesson?.id);
      expect(afterBody.unlockedLessonIds).not.toContain(firstLesson?.id);
    });

    it('refuses a completion whose prerequisites are unmet', async () => {
      const session = await register('prereq');

      // A lesson deep inside T1.M1, whose predecessors have not been done.
      const target = await built.services.db.primary
        .select({ id: lessons.id })
        .from(lessons)
        .where(eq(lessons.slug, 't1-m1-the-bloch-sphere'))
        .limit(1);

      const response = await built.app.inject({
        method: 'POST',
        url: `/progress/lessons/${target[0]?.id}/complete`,
        headers: authHeaders(session),
        payload: { score: 1 },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { code: string; missingLessonIds: number[] };
      expect(body.code).toBe('prerequisites-unmet');
      expect(body.missingLessonIds.length).toBeGreaterThan(0);
    });

    it('schedules and grades a spaced-repetition review', async () => {
      const session = await register('review');

      const next = await built.app.inject({
        method: 'GET',
        url: '/progress/next',
        headers: { cookie: session.cookie },
      });
      const lessonId = (next.json() as { items: Array<{ id: number }> }).items[0]?.id;

      await built.app.inject({
        method: 'POST',
        url: `/progress/lessons/${lessonId}/complete`,
        headers: authHeaders(session),
        payload: { score: 1 },
      });

      const queue = await built.app.inject({
        method: 'GET',
        url: '/progress/review-queue?scope=all',
        headers: { cookie: session.cookie },
      });

      const items = (queue.json() as { items: Array<{ id: string; halfLifeHours: number }> }).items;
      expect(items.length).toBe(1);

      const graded = await built.app.inject({
        method: 'POST',
        url: `/progress/review-queue/${items[0]?.id}/grade`,
        headers: authHeaders(session),
        payload: { grade: 'good' },
      });

      expect(graded.statusCode).toBe(200);
      const outcome = graded.json() as { halfLifeHours: number; dueAt: string };
      // A successful review extends the half-life (syllabus, Mastery model).
      expect(outcome.halfLifeHours).toBeGreaterThan(items[0]?.halfLifeHours as number);
      expect(new Date(outcome.dueAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('§9 idempotency and rate-limit headers', () => {
    it('replays a stored response for a reused Idempotency-Key', async () => {
      const session = await register('idem');
      const key = `it-key-${Date.now()}`;

      const first = await built.app.inject({
        method: 'POST',
        url: '/progress/enrollments',
        headers: authHeaders(session, { 'idempotency-key': key }),
        payload: { trackCode: 'T0' },
      });
      expect(first.statusCode).toBe(201);

      const replay = await built.app.inject({
        method: 'POST',
        url: '/progress/enrollments',
        headers: authHeaders(session, { 'idempotency-key': key }),
        payload: { trackCode: 'T0' },
      });

      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.statusCode).toBe(first.statusCode);
      expect(replay.json()).toEqual(first.json());
    });

    it('rejects the same key used with a different body', async () => {
      const session = await register('idem-mismatch');
      const key = `it-mismatch-${Date.now()}`;

      await built.app.inject({
        method: 'POST',
        url: '/progress/enrollments',
        headers: authHeaders(session, { 'idempotency-key': key }),
        payload: { trackCode: 'T0' },
      });

      const conflicting = await built.app.inject({
        method: 'POST',
        url: '/progress/enrollments',
        headers: authHeaders(session, { 'idempotency-key': key }),
        payload: { trackCode: 'T1' },
      });

      expect(conflicting.statusCode).toBe(409);
      expect(conflicting.json()).toMatchObject({ code: 'idempotency-key-reuse' });
    });

    it('advertises the rate-limit budget on every limited route', async () => {
      const response = await built.app.inject({ method: 'GET', url: '/catalog/tracks' });
      expect(response.headers['ratelimit-limit']).toBe('120');
      expect(Number(response.headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    });
  });

  describe('§7 entitlement gates', () => {
    it('denies the instructor dashboard to a learner', async () => {
      const session = await register('instructor-gate');
      const response = await built.app.inject({
        method: 'GET',
        url: '/instructor/cohorts',
        headers: { cookie: session.cookie },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'forbidden' });
    });

    it('denies noisy simulation on Free with a typed entitlement problem', async () => {
      const session = await register('noisy');
      const lesson = await built.services.db.primary
        .select({ id: lessons.id })
        .from(lessons)
        .where(sql`${lessons.graderKey} is not null`)
        .limit(1);

      const response = await built.app.inject({
        method: 'POST',
        url: '/labs/submit',
        headers: authHeaders(session),
        payload: {
          lessonId: lesson[0]?.id,
          language: 'qiskit',
          source: 'print(1)',
          qubits: 8,
          shots: 1024,
          backend: 'density_matrix',
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json() as { code: string; feature: string; requiredPlan: string };
      expect(body.code).toBe('entitlement-required');
      expect(body.feature).toBe('simulation.noisy');
      expect(body.requiredPlan).toBe('pro');
    });

    it('refuses a statevector job above the plan qubit ceiling', async () => {
      const session = await register('qubits');
      const lesson = await built.services.db.primary
        .select({ id: lessons.id })
        .from(lessons)
        .where(sql`${lessons.graderKey} is not null`)
        .limit(1);

      const response = await built.app.inject({
        method: 'POST',
        url: '/labs/submit',
        headers: authHeaders(session),
        payload: {
          lessonId: lesson[0]?.id,
          language: 'qiskit',
          source: 'print(1)',
          qubits: 24,
          shots: 1024,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'entitlement-required',
        planCap: 16,
        effectiveCap: 16,
      });
    });
  });

  describe('§7 Stripe webhooks', () => {
    it('processes an event once and reports a redelivery as a duplicate', async () => {
      const stripe = built.services.stripe;
      expect(stripe).not.toBeNull();

      const eventId = `evt_it_${Date.now()}`;
      const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        api_version: '2025-02-24.acacia',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: `sub_it_${Date.now()}`,
            object: 'subscription',
            status: 'active',
            customer: 'cus_it_unknown',
            cancel_at_period_end: false,
            trial_end: null,
            canceled_at: null,
            metadata: {},
            items: {
              object: 'list',
              // A price no plan row maps to: the projection returns null and the
              // handler exits without ever calling Stripe.
              data: [{ id: 'si_it', quantity: 1, price: { id: 'price_unmapped_it' } }],
            },
          },
        },
      });

      const header = stripe?.webhooks.generateTestHeaderString({
        payload,
        secret: env.STRIPE_WEBHOOK_SECRET as string,
      }) as string;

      const first = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ received: true, handled: true });

      const replay = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        payload,
      });

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ received: true, duplicate: true });

      // The unique index on stripe_event_id is the whole mechanism (§7).
      const stored = await built.services.db.primary
        .select({ id: stripeEvents.id, status: stripeEvents.status })
        .from(stripeEvents)
        .where(eq(stripeEvents.stripeEventId, eventId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.status).toBe('processed');
    });

    it('rejects an unsigned webhook', async () => {
      const response = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
        payload: JSON.stringify({ id: 'evt_bad', type: 'ping' }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'unauthorized' });
    });
  });

  describe('§6 tutor integrity during a rated contest', () => {
    it('hard-disables hint mode for a registered rated participant', async () => {
      const session = await register('tutor-contest');
      const db = built.services.db.primary;
      const now = Date.now();

      const contest = await db
        .insert(contests)
        .values({
          slug: `it-rated-${now}`,
          title: 'Integration Rated Contest',
          kind: 'rated',
          status: 'running',
          startsAt: new Date(now - 30 * 60_000),
          endsAt: new Date(now + 120 * 60_000),
          freezeMinutes: 60,
        })
        .returning({ id: contests.id });

      const contestId = contest[0]?.id as string;

      await db.insert(problems).values({
        contestId,
        label: 'A',
        slug: `it-problem-${now}`,
        title: 'Integration problem',
        statement: 'Prepare a Bell state.',
        points: 100,
        graderKey: 'it.grader',
        position: 1,
      });

      await db.insert(registrations).values({
        contestId,
        userId: session.userId,
        kind: 'live',
        rated: true,
      });

      const blocked = await built.app.inject({
        method: 'POST',
        url: '/tutor/messages',
        headers: authHeaders(session),
        payload: { mode: 'hint', message: 'How do I solve problem A?' },
      });

      expect(blocked.statusCode).toBe(403);
      const body = blocked.json() as { code: string; contest: string };
      expect(body.code).toBe('tutor-disabled-during-contest');
      expect(body.contest).toBe(`it-rated-${now}`);

      // The usage endpoint reports the same fact, so the UI can grey the button
      // out rather than letting the learner discover it by being refused.
      const usage = await built.app.inject({
        method: 'GET',
        url: '/tutor/usage',
        headers: { cookie: session.cookie },
      });
      expect(usage.json()).toMatchObject({ hintsBlockedByContest: true });
    });

    it('lets an unregistered learner ask for a hint (and fails at the upstream)', async () => {
      const session = await register('tutor-free');

      const response = await built.app.inject({
        method: 'POST',
        url: '/tutor/messages',
        headers: authHeaders(session),
        payload: { mode: 'hint', message: 'Explain phase kickback.' },
      });

      // No tutor service is running in the test environment, so the request gets
      // as far as the proxy and returns a typed upstream failure — which is the
      // proof that the integrity check did not block it.
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'upstream-unavailable' });
    });
  });

  describe('§6 contest registration and submission window', () => {
    it('refuses a submission from an unregistered learner', async () => {
      const session = await register('contest-unreg');
      const db = built.services.db.primary;
      const now = Date.now();

      const contest = await db
        .insert(contests)
        .values({
          slug: `it-open-${now}`,
          title: 'Integration Open Contest',
          kind: 'unrated',
          status: 'running',
          startsAt: new Date(now - 10 * 60_000),
          endsAt: new Date(now + 180 * 60_000),
          freezeMinutes: 60,
        })
        .returning({ id: contests.id });

      const contestId = contest[0]?.id as string;
      const problem = await db
        .insert(problems)
        .values({
          contestId,
          label: 'A',
          slug: `it-open-problem-${now}`,
          title: 'Open problem',
          statement: 'Prepare a GHZ state.',
          points: 200,
          graderKey: 'it.grader',
          position: 1,
        })
        .returning({ id: problems.id });

      const denied = await built.app.inject({
        method: 'POST',
        url: `/contests/${contestId}/submit`,
        headers: authHeaders(session),
        payload: { problemId: problem[0]?.id, language: 'qiskit', source: 'print(1)' },
      });

      expect(denied.statusCode).toBe(403);
      expect((denied.json() as { detail: string }).detail).toContain('Register for the contest');

      // Free plans participate but are never rated (§7).
      const registered = await built.app.inject({
        method: 'POST',
        url: `/contests/${contestId}/register`,
        headers: authHeaders(session),
        payload: { rated: true },
      });

      expect(registered.statusCode).toBe(201);
      expect(registered.json()).toMatchObject({ registered: true, rated: false });
    });
  });

  describe('§6 the scoring path, end to end over HTTP', () => {
    /**
     * The grader's verdict callback is the route that runs the Lua script, so
     * this exercises it the way a grader worker does: an internal service token,
     * an accept, a redelivery of the same accept, and a look at the board.
     */
    it('scores an accepted submission once, through the Lua guard', async () => {
      const session = await register('verdict');
      const db = built.services.db.primary;
      const now = Date.now();

      const contest = await db
        .insert(contests)
        .values({
          slug: `it-verdict-${now}`,
          title: 'Integration Verdict Contest',
          kind: 'unrated',
          status: 'running',
          startsAt: new Date(now - 5 * 60_000),
          endsAt: new Date(now + 180 * 60_000),
          freezeMinutes: 60,
          penaltySecondsPerReject: 1_200,
        })
        .returning({ id: contests.id });

      const contestId = contest[0]?.id as string;

      const problem = await db
        .insert(problems)
        .values({
          contestId,
          label: 'A',
          slug: `it-verdict-problem-${now}`,
          title: 'Verdict problem',
          statement: 'Prepare |+>.',
          points: 500,
          graderKey: 'it.grader',
          position: 1,
        })
        .returning({ id: problems.id });

      const problemId = problem[0]?.id as string;

      await built.app.inject({
        method: 'POST',
        url: `/contests/${contestId}/register`,
        headers: authHeaders(session),
        payload: { rated: false },
      });

      const submitted = await built.app.inject({
        method: 'POST',
        url: `/contests/${contestId}/submit`,
        headers: authHeaders(session),
        payload: {
          problemId,
          language: 'qiskit',
          source: 'from qiskit import QuantumCircuit\nqc = QuantumCircuit(1)\nqc.h(0)\n',
        },
      });

      expect(submitted.statusCode).toBe(202);
      const submissionId = (submitted.json() as { submissionId: string }).submissionId;

      // A grader calls back with an internal service token (§8) — never a session.
      const serviceToken = await built.services.serviceTokens.mint({
        // The gateway's *inbound* audience. `grader` is what the gateway mints
        // when it calls out; it is not a credential for calling back in.
        audience: 'api-gateway',
        subject: session.userId,
        scope: ['contest:verdict'],
      });

      const first = await built.app.inject({
        method: 'POST',
        url: `/contests/${contestId}/verdict`,
        headers: { authorization: `Bearer ${serviceToken}` },
        payload: { submissionId, verdict: 'accepted' },
      });

      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ scored: true, duplicate: false, points: 500 });

      // At-least-once delivery: the redelivery must be a no-op.
      const replay = await built.app.inject({
        method: 'POST',
        url: `/contests/${contestId}/verdict`,
        headers: { authorization: `Bearer ${serviceToken}` },
        payload: { submissionId, verdict: 'accepted' },
      });

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ scored: false, duplicate: true, points: 500 });

      const standings = await built.app.inject({
        method: 'GET',
        url: `/contests/${contestId}/standings`,
        headers: { cookie: session.cookie },
      });

      const board = standings.json() as {
        source: string;
        items: Array<{ rank: number; userId: string; points: number }>;
      };
      expect(board.source).toBe('live');
      expect(board.items).toHaveLength(1);
      expect(board.items[0]).toMatchObject({ rank: 1, userId: session.userId, points: 500 });

      const me = await built.app.inject({
        method: 'GET',
        url: `/contests/${contestId}/me`,
        headers: { cookie: session.cookie },
      });
      expect(me.json()).toMatchObject({ registered: true, rank: 1, solved: [problemId] });
    });

    it('refuses the verdict callback to a user session', async () => {
      const session = await register('verdict-guard');
      const response = await built.app.inject({
        method: 'POST',
        url: `/contests/${'00000000-0000-4000-8000-000000000000'}/verdict`,
        headers: authHeaders(session),
        payload: { submissionId: '00000000-0000-4000-8000-000000000001', verdict: 'accepted' },
      });

      expect(response.statusCode).toBe(403);
      expect((response.json() as { detail: string }).detail).toContain('internal service token');
    });
  });

  describe('admin', () => {
    it('refuses admin routes to a learner', async () => {
      const session = await register('admin-gate');
      const response = await built.app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: { cookie: session.cookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it('reports the §9 degradation ladder to an admin', async () => {
      const session = await register('admin-ok');
      await built.services.db.primary
        .update(users)
        .set({ role: 'admin' })
        .where(eq(users.id, session.userId));

      // A role change bumps privilege and revokes sessions, so sign in again —
      // here by re-reading the session after patching the cached copy.
      await built.services.sessions.patch(
        built.services.sessions.hashToken(
          (session.cookie.match(new RegExp(`${env.SESSION_COOKIE_NAME}=([^;]+)`)) ?? [])[1] ?? '',
        ),
        { role: 'admin', mfaSatisfied: true },
      );

      const response = await built.app.inject({
        method: 'GET',
        url: '/admin/degradation',
        headers: { cookie: session.cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        simQueueOnly: false,
        tutorRetrievalOnly: false,
        writesDisabled: false,
      });
    });
  });
});

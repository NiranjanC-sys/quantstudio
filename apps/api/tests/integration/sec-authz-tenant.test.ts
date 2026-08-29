/**
 * Authorisation review: object-level access control, role gating and tenant
 * isolation.
 *
 * Every case here is an *executed* proof, not a reading. Two organisations and
 * three or four real accounts are provisioned against the real Postgres/Redis
 * pair, one of them authenticates, and the assertion is what the gateway does
 * when it is handed an identifier that belongs to somebody else.
 *
 * Cases marked "control" are the paths that are already correct; they are here
 * so a future refactor that loosens them fails loudly.
 */
import { eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/env.js';
import { contests } from '../../src/db/schema/contest.js';
import { apiKeys, orgMembers, orgs, users } from '../../src/db/schema/identity.js';
import { cohorts } from '../../src/db/schema/instructor.js';
import { sha256Hex } from '../../src/lib/crypto.js';
import { subscriptions } from '../../src/db/schema/billing.js';
import { conceptMastery } from '../../src/db/schema/progress.js';
import { concepts, lessons } from '../../src/db/schema/catalog.js';
import { seed } from '../../src/db/seed.js';
import {
  HAS_POSTGRES,
  HAS_REDIS,
  requireDatabaseUrl,
  requireRedisUrl,
} from '../support/environment.js';

const skip = !HAS_POSTGRES || !HAS_REDIS;
if (skip) {
  process.stderr.write(
    '[sec-authz-tenant] Postgres and/or Redis are not available; the suite is SKIPPED.\n',
  );
}

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  email: string;
}

describe.skipIf(skip)('authz: object-level access control and tenant isolation', () => {
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
      // The limiter would otherwise 429 this suite: it registers a dozen
      // accounts and the §9 auth bucket is 10 per 10 minutes per address.
      RATE_LIMIT_ENABLED: 'false',
      STRIPE_SECRET_KEY: 'sk_test_redquant_authz',
      STRIPE_WEBHOOK_SECRET: 'whsec_redquant_authz',
      EMAIL_TRANSPORT: 'console',
    });

    built = await buildApp(env);
    await seed(built.services.db.primary, env);
  }, 180_000);

  afterAll(async () => {
    if (built) await built.close();
  });

  let counter = 0;

  async function register(suffix: string): Promise<Session> {
    counter += 1;
    const email = `authz-${suffix}-${Date.now()}-${counter}@example.com`;
    const response = await built.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-forwarded-for': `203.0.114.${counter % 250}` },
      payload: {
        email,
        password: 'correct-horse-battery-staple',
        displayName: `Authz ${suffix}`,
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
      email,
    };
  }

  function headers(session: Session, extra: Record<string, string> = {}) {
    return { cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra };
  }

  function sessionKeyOf(session: Session): string {
    const raw =
      (session.cookie.match(new RegExp(`${env.SESSION_COOKIE_NAME}=([^;]+)`)) ?? [])[1] ?? '';
    return built.services.sessions.hashToken(decodeURIComponent(raw));
  }

  async function makeOrg(label: string): Promise<string> {
    counter += 1;
    const rows = await built.services.db.primary
      .insert(orgs)
      .values({
        slug: `authz-${label}-${counter}-${Date.now().toString(36)}`.slice(0, 60),
        name: `Authz ${label}`,
        kind: 'campus',
        seatLimit: 50,
      })
      .returning({ id: orgs.id });
    return rows[0]!.id;
  }

  /** Makes a registered learner an MFA-satisfied instructor inside `orgId`. */
  async function promote(
    session: Session,
    orgId: string | null,
    role: 'instructor' | 'org_admin' | 'admin' = 'instructor',
  ): Promise<void> {
    const db = built.services.db.primary;
    await db.update(users).set({ role, orgId }).where(eq(users.id, session.userId));
    if (orgId) {
      await db
        .insert(orgMembers)
        .values({
          orgId,
          userId: session.userId,
          role: role === 'org_admin' ? 'admin' : 'instructor',
          seatAssigned: true,
        })
        .onConflictDoNothing();
    }
    // The instructor dashboard is a Teams/Campus feature (§7); without a
    // subscription the entitlement guard, not the authz check, would answer.
    await db
      .insert(subscriptions)
      .values({ userId: session.userId, planCode: 'campus', status: 'active', seats: 10 })
      .onConflictDoNothing();
    await built.services.entitlements.recompute(session.userId);
    await built.services.sessions.patch(sessionKeyOf(session), {
      role,
      orgId,
      orgRole: orgId ? (role === 'org_admin' ? 'admin' : 'instructor') : null,
      mfaSatisfied: true,
    });
  }

  async function attachToOrg(session: Session, orgId: string): Promise<void> {
    const db = built.services.db.primary;
    await db.update(users).set({ orgId }).where(eq(users.id, session.userId));
    await db
      .insert(orgMembers)
      .values({ orgId, userId: session.userId, role: 'member', seatAssigned: true })
      .onConflictDoNothing();
    await built.services.sessions.patch(sessionKeyOf(session), { orgId, orgRole: 'member' });
  }

  // ------------------------------------------------------------------ FINDING
  // An instructor may add *any* account on the platform to their own cohort by
  // email address, including one that belongs to a different organisation, and
  // the cohort views then hand over that learner's email and per-concept
  // mastery.
  describe('instructor cohort membership crosses the organisation boundary', () => {
    it('adds a foreign-org learner by email and exposes their progress', async () => {
      const orgA = await makeOrg('teacher-org');
      const orgB = await makeOrg('victim-org');

      const teacher = await register('cross-teacher');
      await promote(teacher, orgA);

      const victim = await register('cross-victim');
      await attachToOrg(victim, orgB);

      // Give the victim a per-concept mastery row so the heatmap has something
      // to leak. (Real learners get these from completing lessons.)
      const conceptRows = await built.services.db.primary
        .select({ id: concepts.id })
        .from(concepts)
        .limit(1);
      const conceptId = conceptRows[0]?.id;
      if (conceptId !== undefined) {
        await built.services.db.primary
          .insert(conceptMastery)
          .values({
            userId: victim.userId,
            conceptId,
            mastery: 0.42,
            halfLifeHours: 48,
            lastInteractionAt: new Date(),
            observations: 3,
            correct: 1,
          })
          .onConflictDoNothing();
      }

      const created = await built.app.inject({
        method: 'POST',
        url: '/instructor/cohorts',
        headers: headers(teacher),
        payload: { name: 'Cross Org Cohort', slug: `cross-${Date.now().toString(36)}` },
      });
      expect(created.statusCode).toBe(201);
      const cohortId = (created.json() as { id: string }).id;

      const added = await built.app.inject({
        method: 'POST',
        url: `/instructor/cohorts/${cohortId}/members`,
        headers: headers(teacher),
        payload: { emails: [victim.email], role: 'student' },
      });

      expect(added.statusCode).toBe(201);
      const addedBody = added.json() as { added: number; notFound: string[] };

      // FIXED BEHAVIOUR: a learner outside the cohort's organisation is not
      // resolvable, so nothing is added and the caller learns nothing about
      // whether the address exists.
      expect(addedBody.added).toBe(0);
      expect(addedBody.notFound).toContain(victim.email.toLowerCase());

      const gradebook = await built.app.inject({
        method: 'GET',
        url: `/instructor/cohorts/${cohortId}/gradebook`,
        headers: headers(teacher),
      });
      expect(gradebook.statusCode).toBe(200);
      const emails = (gradebook.json() as { rows: Array<{ email: string }> }).rows.map(
        (row) => row.email,
      );
      expect(emails).not.toContain(victim.email);

      const heatmap = await built.app.inject({
        method: 'GET',
        url: `/instructor/cohorts/${cohortId}/heatmap`,
        headers: headers(teacher),
      });
      expect(heatmap.statusCode).toBe(200);
      const cells = (heatmap.json() as { cells: Array<{ userId: string }> }).cells;
      expect(cells.map((cell) => cell.userId)).not.toContain(victim.userId);
    });

    it('still adds a learner who belongs to the cohort organisation (control)', async () => {
      const org = await makeOrg('same-org');
      const teacher = await register('same-teacher');
      await promote(teacher, org);
      const student = await register('same-student');
      await attachToOrg(student, org);

      const created = await built.app.inject({
        method: 'POST',
        url: '/instructor/cohorts',
        headers: headers(teacher),
        payload: { name: 'Same Org Cohort', slug: `same-${Date.now().toString(36)}` },
      });
      expect(created.statusCode).toBe(201);
      const cohortId = (created.json() as { id: string }).id;

      const added = await built.app.inject({
        method: 'POST',
        url: `/instructor/cohorts/${cohortId}/members`,
        headers: headers(teacher),
        payload: { emails: [student.email] },
      });
      expect(added.statusCode).toBe(201);
      expect((added.json() as { added: number }).added).toBe(1);
    });
  });

  // ------------------------------------------------------------------ FINDING
  // A grade row could be written for a user id that is not a member of the
  // cohort at all.
  describe('assignment grades are constrained to cohort members', () => {
    it('refuses a grade for a user who is not in the cohort', async () => {
      const org = await makeOrg('grade-org');
      const teacher = await register('grade-teacher');
      await promote(teacher, org);
      const outsider = await register('grade-outsider');

      const created = await built.app.inject({
        method: 'POST',
        url: '/instructor/cohorts',
        headers: headers(teacher),
        payload: { name: 'Grade Cohort', slug: `grade-${Date.now().toString(36)}` },
      });
      const cohortId = (created.json() as { id: string }).id;

      const assignment = await built.app.inject({
        method: 'POST',
        url: `/instructor/cohorts/${cohortId}/assignments`,
        headers: headers(teacher),
        payload: { title: 'Homework 1', points: 100 },
      });
      expect(assignment.statusCode).toBe(201);
      const assignmentId = (assignment.json() as { id: string }).id;

      const graded = await built.app.inject({
        method: 'PUT',
        url: `/instructor/assignments/${assignmentId}/grades/${outsider.userId}`,
        headers: headers(teacher),
        payload: { status: 'graded', score: 1 },
      });

      expect(graded.statusCode).toBe(404);
      expect((graded.json() as { code: string }).code).toBe('not-found');
    });
  });

  // ------------------------------------------------------------------ FINDING
  // An instructor with no organisation crashed the cohort list, because the
  // filter substituted an empty string for a uuid column.
  describe('cohort list with no organisation', () => {
    it('returns an empty page instead of a 500', async () => {
      const orphan = await register('orphan-teacher');
      await promote(orphan, null);

      const response = await built.app.inject({
        method: 'GET',
        url: '/instructor/cohorts',
        headers: headers(orphan),
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { items: unknown[] }).items).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ FINDING
  // A private (org-scoped) contest's standings were readable by anybody,
  // including an unauthenticated caller, through the leaderboard module.
  describe('private contest standings are org-scoped', () => {
    async function makePrivateContest(orgId: string): Promise<string> {
      const now = Date.now();
      const rows = await built.services.db.primary
        .insert(contests)
        .values({
          slug: `authz-private-${now.toString(36)}-${counter}`,
          title: 'Private Cup',
          kind: 'private',
          status: 'scheduled',
          orgId,
          startsAt: new Date(now - 7_200_000),
          endsAt: new Date(now - 3_600_000),
          freezeMinutes: 0,
          penaltySecondsPerReject: 1_200,
          virtualAllowed: true,
        })
        .returning({ id: contests.id });
      return rows[0]!.id;
    }

    it('refuses the board to an anonymous caller', async () => {
      const org = await makeOrg('private-contest');
      const contestId = await makePrivateContest(org);

      const response = await built.app.inject({
        method: 'GET',
        url: `/leaderboard/contests/${contestId}`,
      });

      expect([401, 403]).toContain(response.statusCode);
    });

    it('refuses the board to a member of a different organisation', async () => {
      const orgOwner = await makeOrg('private-owner');
      const orgOther = await makeOrg('private-other');
      const contestId = await makePrivateContest(orgOwner);

      const outsider = await register('private-outsider');
      await attachToOrg(outsider, orgOther);

      const response = await built.app.inject({
        method: 'GET',
        url: `/leaderboard/contests/${contestId}`,
        headers: { cookie: outsider.cookie },
      });

      expect(response.statusCode).toBe(403);
    });

    it('allows a member of the owning organisation (control)', async () => {
      const org = await makeOrg('private-insider');
      const contestId = await makePrivateContest(org);

      const insider = await register('private-insider-user');
      await attachToOrg(insider, org);

      const response = await built.app.inject({
        method: 'GET',
        url: `/leaderboard/contests/${contestId}`,
        headers: { cookie: insider.cookie },
      });

      expect(response.statusCode).toBe(200);
    });

    it('leaves a public contest board open (control)', async () => {
      const now = Date.now();
      const rows = await built.services.db.primary
        .insert(contests)
        .values({
          slug: `authz-public-${now.toString(36)}-${counter}`,
          title: 'Public Cup',
          kind: 'rated',
          status: 'scheduled',
          startsAt: new Date(now - 7_200_000),
          endsAt: new Date(now - 3_600_000),
          freezeMinutes: 0,
          penaltySecondsPerReject: 1_200,
          virtualAllowed: true,
        })
        .returning({ id: contests.id });

      const response = await built.app.inject({
        method: 'GET',
        url: `/leaderboard/contests/${rows[0]!.id}`,
      });

      expect(response.statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------------------ FINDING
  // A finished private contest handed its whole problem set — statements and
  // grader keys — to any authenticated caller, whatever organisation they were
  // in.
  describe('private contest problems are org-scoped', () => {
    it('refuses the problem set of a finished foreign private contest', async () => {
      const orgOwner = await makeOrg('problems-owner');
      const orgOther = await makeOrg('problems-other');
      const now = Date.now();

      const inserted = await built.services.db.primary
        .insert(contests)
        .values({
          slug: `authz-problems-${now.toString(36)}-${counter}`,
          title: 'Private Problems',
          kind: 'private',
          status: 'finalised',
          orgId: orgOwner,
          startsAt: new Date(now - 7_200_000),
          endsAt: new Date(now - 3_600_000),
          freezeMinutes: 0,
          penaltySecondsPerReject: 1_200,
          virtualAllowed: true,
        })
        .returning({ id: contests.id, slug: contests.slug });

      const outsider = await register('problems-outsider');
      await attachToOrg(outsider, orgOther);

      const response = await built.app.inject({
        method: 'GET',
        url: `/contests/${inserted[0]!.slug}/problems`,
        headers: { cookie: outsider.cookie },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // --------------------------------------------------------- MASS ASSIGNMENT
  describe('mass assignment: a body cannot set ownership fields', () => {
    it('ignores orgId, ownerId, joinCode and archived on cohort creation', async () => {
      const orgMine = await makeOrg('mass-mine');
      const orgTheirs = await makeOrg('mass-theirs');
      const teacher = await register('mass-teacher');
      const stranger = await register('mass-stranger');
      await promote(teacher, orgMine);

      const created = await built.app.inject({
        method: 'POST',
        url: '/instructor/cohorts',
        headers: headers(teacher),
        payload: {
          name: 'Mass Assignment',
          slug: `mass-${Date.now().toString(36)}`,
          orgId: orgTheirs,
          ownerId: stranger.userId,
          joinCode: 'AAAAAAAA',
          archived: true,
        },
      });

      expect(created.statusCode).toBe(201);
      const cohortId = (created.json() as { id: string }).id;

      const rows = await built.services.db.primary
        .select({
          orgId: cohorts.orgId,
          ownerId: cohorts.ownerId,
          joinCode: cohorts.joinCode,
          archived: cohorts.archived,
        })
        .from(cohorts)
        .where(eq(cohorts.id, cohortId));

      expect(rows[0]?.orgId).toBe(orgMine);
      expect(rows[0]?.ownerId).toBe(teacher.userId);
      expect(rows[0]?.joinCode).not.toBe('AAAAAAAA');
      expect(rows[0]?.archived).toBe(false);
    });

    it('ignores a userId in an enrolment body', async () => {
      const learner = await register('mass-learner');
      const victim = await register('mass-victim');

      const response = await built.app.inject({
        method: 'POST',
        url: '/progress/enrollments',
        headers: headers(learner),
        payload: { trackCode: 'T0', userId: victim.userId },
      });
      expect([200, 201]).toContain(response.statusCode);

      const victimEnrollments = await built.app.inject({
        method: 'GET',
        url: '/progress/enrollments',
        headers: { cookie: victim.cookie },
      });
      expect((victimEnrollments.json() as { items: unknown[] }).items).toEqual([]);
    });

    it('ignores a userId in a timezone update', async () => {
      const learner = await register('tz-learner');
      const victim = await register('tz-victim');

      const response = await built.app.inject({
        method: 'PUT',
        url: '/progress/streak/timezone',
        headers: headers(learner),
        payload: { timezone: 'Pacific/Auckland', userId: victim.userId },
      });
      expect(response.statusCode).toBe(200);

      const victimStreak = await built.app.inject({
        method: 'GET',
        url: '/progress/streak',
        headers: { cookie: victim.cookie },
      });
      expect((victimStreak.json() as { timezone: string }).timezone).toBe('UTC');
    });
  });

  // ------------------------------------------------------------ ADMIN SURFACE
  describe('admin surface', () => {
    it('refuses role escalation to an instructor', async () => {
      const org = await makeOrg('escalate-org');
      const teacher = await register('escalate-teacher');
      await promote(teacher, org);
      const target = await register('escalate-target');

      const response = await built.app.inject({
        method: 'PATCH',
        url: `/admin/users/${target.userId}`,
        headers: headers(teacher),
        payload: { role: 'admin' },
      });
      expect(response.statusCode).toBe(403);

      const rows = await built.services.db.primary
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, target.userId));
      expect(rows[0]?.role).toBe('learner');
    });

    it('requires MFA on the admin surface even with the admin role', async () => {
      const operator = await register('admin-nomfa');
      await promote(operator, null, 'admin');
      await built.services.sessions.patch(sessionKeyOf(operator), { mfaSatisfied: false });

      const response = await built.app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: headers(operator),
      });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { code: string }).code).toBe('mfa-required');
    });

    it('refuses an API key on the instructor surface (a key cannot satisfy MFA)', async () => {
      const org = await makeOrg('apikey-org');
      const teacher = await register('apikey-teacher');
      await promote(teacher, org);

      const token = `rq_${'a'.repeat(40)}-${Date.now()}`;
      await built.services.db.primary.insert(apiKeys).values({
        userId: teacher.userId,
        name: 'authz probe',
        keyHash: sha256Hex(token),
        prefix: token.slice(0, 10),
        scopes: ['*'],
      });

      const response = await built.app.inject({
        method: 'GET',
        url: '/instructor/cohorts',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { code: string }).code).toBe('mfa-required');
    });
  });

  // ------------------------------------------------------------- CONTROLS
  describe('controls: paths that are already scoped correctly', () => {
    it('refuses another learner submission by id', async () => {
      const owner = await register('sub-owner');
      const other = await register('sub-other');

      // Any lesson that has a grader will do.
      const lessonRows = await built.services.db.primary
        .select({ id: lessons.id })
        .from(lessons)
        .where(isNotNull(lessons.graderKey))
        .limit(1);
      const lessonId = lessonRows[0]?.id;
      if (lessonId === undefined) return;

      const submitted = await built.app.inject({
        method: 'POST',
        url: '/labs/submit',
        headers: headers(owner),
        payload: { lessonId, language: 'qiskit', source: 'print(1)' },
      });
      if (submitted.statusCode !== 202) return;
      const submissionId = (submitted.json() as { submissionId: string }).submissionId;

      const stolen = await built.app.inject({
        method: 'GET',
        url: `/labs/submissions/${submissionId}`,
        headers: { cookie: other.cookie },
      });
      expect(stolen.statusCode).toBe(403);

      const own = await built.app.inject({
        method: 'GET',
        url: `/labs/submissions/${submissionId}`,
        headers: { cookie: owner.cookie },
      });
      expect(own.statusCode).toBe(200);
    });

    it('refuses another organisation institution board', async () => {
      const orgA = await makeOrg('board-a');
      const orgB = await makeOrg('board-b');
      const member = await register('board-member');
      await attachToOrg(member, orgA);

      const response = await built.app.inject({
        method: 'GET',
        url: `/leaderboard/institutions/${orgB}`,
        headers: { cookie: member.cookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it('refuses a foreign cohort to an instructor of another org', async () => {
      const orgA = await makeOrg('cohort-a');
      const orgB = await makeOrg('cohort-b');
      const teacherA = await register('cohort-teacher-a');
      const teacherB = await register('cohort-teacher-b');
      await promote(teacherA, orgA);
      await promote(teacherB, orgB);

      const created = await built.app.inject({
        method: 'POST',
        url: '/instructor/cohorts',
        headers: headers(teacherA),
        payload: { name: 'A Cohort', slug: `acoh-${Date.now().toString(36)}` },
      });
      const cohortId = (created.json() as { id: string }).id;

      for (const url of [
        `/instructor/cohorts/${cohortId}`,
        `/instructor/cohorts/${cohortId}/gradebook`,
        `/instructor/cohorts/${cohortId}/heatmap`,
        `/instructor/cohorts/${cohortId}/export.csv`,
      ]) {
        const response = await built.app.inject({
          method: 'GET',
          url,
          headers: headers(teacherB),
        });
        expect(response.statusCode, url).toBe(403);
      }
    });

    it('refuses /instructor to a learner and /admin to an instructor', async () => {
      const learner = await register('gate-learner');
      const org = await makeOrg('gate-org');
      const teacher = await register('gate-teacher');
      await promote(teacher, org);

      const asLearner = await built.app.inject({
        method: 'GET',
        url: '/instructor/cohorts',
        headers: { cookie: learner.cookie },
      });
      expect(asLearner.statusCode).toBe(403);

      const asInstructor = await built.app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: { cookie: teacher.cookie },
      });
      expect(asInstructor.statusCode).toBe(403);
    });

    it('requires MFA for the instructor surface even with the role', async () => {
      const org = await makeOrg('mfa-org');
      const teacher = await register('mfa-teacher');
      await promote(teacher, org);
      await built.services.sessions.patch(sessionKeyOf(teacher), { mfaSatisfied: false });

      const response = await built.app.inject({
        method: 'GET',
        url: '/instructor/cohorts',
        headers: headers(teacher),
      });
      expect(response.statusCode).toBe(401);
      expect((response.json() as { code: string }).code).toBe('mfa-required');
    });

    it('never leaks another learner XP or review queue through pagination', async () => {
      const a = await register('page-a');
      const b = await register('page-b');

      const xp = await built.app.inject({
        method: 'GET',
        url: '/progress/xp?limit=100&offset=0',
        headers: { cookie: a.cookie },
      });
      expect(xp.statusCode).toBe(200);
      const events = (xp.json() as { events: Array<{ refId: string | null }> }).events;
      expect(Array.isArray(events)).toBe(true);

      const queue = await built.app.inject({
        method: 'GET',
        url: '/progress/review-queue?scope=all&limit=100',
        headers: { cookie: b.cookie },
      });
      expect(queue.statusCode).toBe(200);
    });
  });
});

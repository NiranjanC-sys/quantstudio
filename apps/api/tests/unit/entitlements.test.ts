/**
 * The §7 plan matrix, transcribed from system-design and asserted cell by cell.
 *
 * These tests exist because entitlements are the one thing in the product that
 * is simultaneously a revenue decision, a security boundary and a pure function.
 * If the matrix drifts from the document, everything downstream is wrong and
 * nothing else fails.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/errors.js';
import {
  assertFeature,
  canReadTrack,
  effectivePlan,
  entitlementsFor,
  freeSubscription,
  hasFeature,
  interviewBankSize,
  maxQubitsFor,
  PAST_DUE_GRACE_MS,
  ssoAllowed,
  type SubscriptionState,
} from '../../src/entitlements/index.js';

function subscription(overrides: Partial<SubscriptionState>): SubscriptionState {
  return {
    planCode: 'pro',
    status: 'active',
    seats: 1,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

describe('the §7 matrix', () => {
  it('gives Free the row system-design specifies', () => {
    const free = entitlementsFor(freeSubscription());

    expect(free.plan).toBe('free');
    expect(free.maxTrackCode).toBe('T1');
    expect(free.labsPerMonth).toBe(40);
    expect(free.maxQubits).toBe(16);
    expect(free.noisyMaxQubits).toBeNull();
    expect(free.simCreditsPerMonth).toBe(500);
    expect(free.tutorMessagesPerDay).toBe(15);
    expect(free.contests).toEqual({
      participate: true,
      rated: false,
      editorials: false,
      private: false,
    });
    expect(free.interviewQuestions).toBe(20);
    expect(free.instructorDashboard).toBe(false);
    expect(free.sso).toEqual(['google', 'github']);
    expect(free.certificates).toBe('none');
    // §9: 30/min on Free.
    expect(free.simulationsPerMinute).toBe(30);
  });

  it('gives Pro the row system-design specifies', () => {
    const pro = entitlementsFor(subscription({ planCode: 'pro' }));

    expect(pro.maxTrackCode).toBeNull();
    expect(pro.labsPerMonth).toBeNull();
    expect(pro.maxQubits).toBe(28);
    expect(pro.noisyMaxQubits).toBe(12);
    expect(pro.simCreditsPerMonth).toBe(20_000);
    expect(pro.tutorMessagesPerDay).toBe(300);
    expect(pro.contests.rated).toBe(true);
    expect(pro.contests.editorials).toBe(true);
    expect(pro.contests.private).toBe(false);
    expect(pro.interviewQuestions).toBeNull();
    expect(pro.instructorDashboard).toBe(false);
    expect(pro.sso).toContain('microsoft');
    expect(pro.sso).toContain('orcid');
    expect(pro.sso).not.toContain('saml');
    expect(pro.certificates).toBe('standard');
    // §9: 240/min on Pro.
    expect(pro.simulationsPerMinute).toBe(240);
  });

  it('gives Teams the row system-design specifies, priced per seat', () => {
    const teams = entitlementsFor(subscription({ planCode: 'teams', seats: 1 }));

    expect(teams.maxQubits).toBe(30);
    expect(teams.noisyMaxQubits).toBe(14);
    expect(teams.instructorDashboard).toBe(true);
    expect(teams.contests.private).toBe(true);
    expect(teams.sso).toContain('saml');
    expect(teams.scimProvisioning).toBe(false);
    // "50,000/seat".
    expect(teams.simCreditsPerMonth).toBe(50_000);
    expect(entitlementsFor(subscription({ planCode: 'teams', seats: 12 })).simCreditsPerMonth).toBe(
      600_000,
    );
  });

  it('gives Campus the row system-design specifies, with negotiated credits', () => {
    const campus = entitlementsFor(subscription({ planCode: 'campus' }));

    expect(campus.maxQubits).toBe(32);
    expect(campus.noisyMaxQubits).toBe(14);
    expect(campus.instructorDashboard).toBe(true);
    expect(campus.scimProvisioning).toBe(true);
    expect(campus.certificates).toBe('co-branded');
    // "negotiated" is null in the matrix, and comes from the subscription.
    expect(campus.simCreditsPerMonth).toBeNull();
    expect(
      entitlementsFor(
        subscription({ planCode: 'campus', negotiatedCreditsPerMonth: 2_500_000 }),
      ).simCreditsPerMonth,
    ).toBe(2_500_000);
  });

  it('never lets a caller mutate the shared matrix', () => {
    const first = entitlementsFor(subscription({ planCode: 'pro' }));
    first.maxQubits = 9_999;
    first.contests.rated = false;

    const second = entitlementsFor(subscription({ planCode: 'pro' }));
    expect(second.maxQubits).toBe(28);
    expect(second.contests.rated).toBe(true);
  });
});

describe('effectivePlan', () => {
  const now = new Date('2026-06-15T00:00:00Z');

  it('honours active and trialing subscriptions', () => {
    expect(effectivePlan(subscription({ status: 'active' }), now)).toBe('pro');
    expect(effectivePlan(subscription({ status: 'trialing' }), now)).toBe('pro');
  });

  it('keeps a past_due subscription working through the grace window', () => {
    // §9 step 5: a Stripe outage must be invisible to a paying customer.
    const insideGrace = subscription({
      status: 'past_due',
      currentPeriodEnd: new Date(now.getTime() - PAST_DUE_GRACE_MS + 60_000),
    });
    expect(effectivePlan(insideGrace, now)).toBe('pro');

    const pastGrace = subscription({
      status: 'past_due',
      currentPeriodEnd: new Date(now.getTime() - PAST_DUE_GRACE_MS - 60_000),
    });
    expect(effectivePlan(pastGrace, now)).toBe('free');
  });

  it('keeps a cancelled subscription until the period the customer paid for ends', () => {
    const stillPaid = subscription({
      status: 'canceled',
      currentPeriodEnd: new Date(now.getTime() + 86_400_000),
    });
    expect(effectivePlan(stillPaid, now)).toBe('pro');

    const expired = subscription({
      status: 'canceled',
      currentPeriodEnd: new Date(now.getTime() - 1),
    });
    expect(effectivePlan(expired, now)).toBe('free');
  });

  it('treats incomplete and paused as free', () => {
    expect(effectivePlan(subscription({ status: 'incomplete' }), now)).toBe('free');
    expect(effectivePlan(subscription({ status: 'paused' }), now)).toBe('free');
  });
});

describe('feature gates', () => {
  const free = entitlementsFor(freeSubscription());
  const pro = entitlementsFor(subscription({ planCode: 'pro' }));
  const teams = entitlementsFor(subscription({ planCode: 'teams' }));
  const campus = entitlementsFor(subscription({ planCode: 'campus' }));

  it('gates the catalogue at T1 on Free and nowhere on paid plans', () => {
    expect(canReadTrack(free, 'T0')).toBe(true);
    expect(canReadTrack(free, 'T1')).toBe(true);
    expect(canReadTrack(free, 'T2')).toBe(false);
    expect(canReadTrack(free, 'T7')).toBe(false);
    for (const plan of [pro, teams, campus]) {
      expect(canReadTrack(plan, 'T7')).toBe(true);
    }
  });

  it('maps every named feature onto the matrix', () => {
    expect(hasFeature(free, 'contests.rated')).toBe(false);
    expect(hasFeature(pro, 'contests.rated')).toBe(true);
    expect(hasFeature(pro, 'contests.private')).toBe(false);
    expect(hasFeature(teams, 'contests.private')).toBe(true);
    expect(hasFeature(pro, 'instructor.dashboard')).toBe(false);
    expect(hasFeature(teams, 'instructor.dashboard')).toBe(true);
    expect(hasFeature(free, 'simulation.noisy')).toBe(false);
    expect(hasFeature(pro, 'simulation.noisy')).toBe(true);
    expect(hasFeature(free, 'certificates.issue')).toBe(false);
    expect(hasFeature(campus, 'scim.provisioning')).toBe(true);
    expect(hasFeature(teams, 'scim.provisioning')).toBe(false);
    expect(hasFeature(free, 'labs.unlimited')).toBe(false);
    expect(hasFeature(pro, 'labs.unlimited')).toBe(true);
    expect(hasFeature(free, 'catalog.full')).toBe(false);
  });

  it('throws a typed problem naming the feature and the plan that unlocks it', () => {
    expect(() => assertFeature(pro, 'contests.rated')).not.toThrow();

    try {
      assertFeature(free, 'instructor.dashboard');
      expect.unreachable('assertFeature should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe('entitlement-required');
      expect(apiError.status).toBe(403);
      expect(apiError.extensions['feature']).toBe('instructor.dashboard');
      expect(apiError.extensions['currentPlan']).toBe('free');
      expect(apiError.extensions['requiredPlan']).toBe('teams');
      expect(apiError.toProblem().type).toBe(
        'https://redquant.io/problems/entitlement-required',
      );
    }
  });

  it('applies the §4 memory guard per plan and per simulation kind', () => {
    expect(maxQubitsFor(free, 'statevector')).toBe(16);
    expect(maxQubitsFor(free, 'noisy')).toBeNull();
    expect(maxQubitsFor(pro, 'noisy')).toBe(12);
    expect(maxQubitsFor(campus, 'statevector')).toBe(32);
  });

  it('sizes the interview bank per §7', () => {
    expect(interviewBankSize(free)).toBe(20);
    expect(interviewBankSize(pro)).toBe(240);
  });

  it('gates SSO providers per plan', () => {
    expect(ssoAllowed(free, 'google')).toBe(true);
    expect(ssoAllowed(free, 'microsoft')).toBe(false);
    expect(ssoAllowed(pro, 'orcid')).toBe(true);
    expect(ssoAllowed(pro, 'saml')).toBe(false);
    expect(ssoAllowed(teams, 'saml')).toBe(true);
  });
});

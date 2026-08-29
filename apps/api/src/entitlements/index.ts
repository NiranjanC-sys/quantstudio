/**
 * Entitlements are a pure function of subscription state (system-design §7),
 * evaluated at the gateway and cached in the session.
 *
 * Nothing in this module performs I/O. In particular it never calls Stripe:
 * §9's degradation ladder requires that a Stripe outage leave paying users with
 * their features intact, which is only true if feature checks read the
 * materialised `billing.entitlements` table and this function.
 */
import { ApiError } from '../errors.js';
import {
  INTERVIEW_BANK_SIZE,
  PLAN_MATRIX,
  type Entitlements,
  type PlanCode,
  type SsoProvider,
} from './matrix.js';

export * from './matrix.js';

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'paused';

export interface SubscriptionState {
  planCode: PlanCode;
  status: SubscriptionStatus;
  /** Teams is priced per seat and grants credits per seat. */
  seats: number;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Campus credits are negotiated; the number lives on the subscription. */
  negotiatedCreditsPerMonth?: number | null;
}

/**
 * How long a `past_due` subscription keeps its features. §9 step 5 wants a
 * Stripe outage to be invisible to a paying user, and dunning takes days, so the
 * gateway does not downgrade the instant an invoice fails.
 */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const FREE: SubscriptionState = {
  planCode: 'free',
  status: 'active',
  seats: 1,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

/** The subscription state of a user with no subscription row at all. */
export function freeSubscription(): SubscriptionState {
  return { ...FREE };
}

/**
 * Resolves which plan a subscription actually confers right now.
 *
 * - `active` / `trialing` → the subscription's plan.
 * - `past_due` → the plan, until the grace window after the period ends.
 * - `canceled` → the plan until the paid-for period ends, then free.
 * - `incomplete` / `paused` → free; the customer has not paid or has stopped.
 */
export function effectivePlan(subscription: SubscriptionState, now: Date = new Date()): PlanCode {
  const { status, planCode, currentPeriodEnd } = subscription;

  switch (status) {
    case 'active':
    case 'trialing':
      return planCode;

    case 'past_due': {
      if (!currentPeriodEnd) return planCode;
      return now.getTime() <= currentPeriodEnd.getTime() + PAST_DUE_GRACE_MS ? planCode : 'free';
    }

    case 'canceled': {
      if (!currentPeriodEnd) return 'free';
      return now.getTime() <= currentPeriodEnd.getTime() ? planCode : 'free';
    }

    case 'incomplete':
    case 'paused':
      return 'free';
  }
}

/**
 * The §7 matrix for a subscription. Pure: same input, same output, no clock
 * beyond the `now` you pass, no network.
 */
export function entitlementsFor(
  subscription: SubscriptionState = FREE,
  now: Date = new Date(),
): Entitlements {
  const plan = effectivePlan(subscription, now);
  const base = PLAN_MATRIX[plan];

  // Teams grants credits per seat ("50,000/seat"); Campus is negotiated.
  let simCreditsPerMonth: number | null = base.simCreditsPerMonth;
  if (plan === 'teams' && base.simCreditsPerMonth !== null) {
    simCreditsPerMonth = base.simCreditsPerMonth * Math.max(1, subscription.seats);
  } else if (plan === 'campus') {
    simCreditsPerMonth = subscription.negotiatedCreditsPerMonth ?? null;
  }

  return {
    ...base,
    contests: { ...base.contests },
    sso: [...base.sso],
    simCreditsPerMonth,
  };
}

/** Track gating: Free reads T0-T1, every paid plan reads everything. */
export function canReadTrack(entitlements: Entitlements, trackCode: string): boolean {
  if (entitlements.maxTrackCode === null) return true;
  return trackCode <= entitlements.maxTrackCode;
}

/** §4 memory guard, applied per plan and per simulation kind. */
export function maxQubitsFor(
  entitlements: Entitlements,
  kind: 'statevector' | 'noisy',
): number | null {
  if (kind === 'statevector') return entitlements.maxQubits;
  return entitlements.noisyMaxQubits;
}

export function interviewBankSize(entitlements: Entitlements): number {
  return entitlements.interviewQuestions ?? INTERVIEW_BANK_SIZE;
}

export function ssoAllowed(entitlements: Entitlements, provider: SsoProvider): boolean {
  return entitlements.sso.includes(provider);
}

export interface FeatureChecks {
  'contests.rated': boolean;
  'contests.private': boolean;
  'contests.editorials': boolean;
  'instructor.dashboard': boolean;
  'simulation.noisy': boolean;
  'certificates.issue': boolean;
  'sso.saml': boolean;
  'scim.provisioning': boolean;
  'labs.unlimited': boolean;
  'catalog.full': boolean;
}

export type FeatureName = keyof FeatureChecks;

/** A single place that maps a feature name onto the matrix. */
export function hasFeature(entitlements: Entitlements, feature: FeatureName): boolean {
  switch (feature) {
    case 'contests.rated':
      return entitlements.contests.rated;
    case 'contests.private':
      return entitlements.contests.private;
    case 'contests.editorials':
      return entitlements.contests.editorials;
    case 'instructor.dashboard':
      return entitlements.instructorDashboard;
    case 'simulation.noisy':
      return entitlements.noisyMaxQubits !== null;
    case 'certificates.issue':
      return entitlements.certificates !== 'none';
    case 'sso.saml':
      return entitlements.sso.includes('saml');
    case 'scim.provisioning':
      return entitlements.scimProvisioning;
    case 'labs.unlimited':
      return entitlements.labsPerMonth === null;
    case 'catalog.full':
      return entitlements.maxTrackCode === null;
  }
}

const UPGRADE_HINT: Record<FeatureName, PlanCode> = {
  'contests.rated': 'pro',
  'contests.private': 'teams',
  'contests.editorials': 'pro',
  'instructor.dashboard': 'teams',
  'simulation.noisy': 'pro',
  'certificates.issue': 'pro',
  'sso.saml': 'teams',
  'scim.provisioning': 'campus',
  'labs.unlimited': 'pro',
  'catalog.full': 'pro',
};

/** Throws a problem+json 403 naming the feature and the plan that unlocks it. */
export function assertFeature(entitlements: Entitlements, feature: FeatureName): void {
  if (hasFeature(entitlements, feature)) return;
  throw new ApiError(
    'entitlement-required',
    `Your ${entitlements.plan} plan does not include ${feature}.`,
    { extensions: { feature, currentPlan: entitlements.plan, requiredPlan: UPGRADE_HINT[feature] } },
  );
}

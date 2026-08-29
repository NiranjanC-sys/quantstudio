/**
 * Stripe reconciliation (system-design §7).
 *
 *   "the entitlement table is the source of truth and is reconciled by a nightly
 *    job that replays Stripe state."
 *
 * Two things live here: the projection of one Stripe subscription onto our
 * `billing.subscriptions` + `billing.entitlements` rows, and the nightly sweep
 * that replays every subscription and repairs drift. The webhook handler and the
 * sweep call the same projection, so a missed webhook is not a different code
 * path — it is the same one, run later.
 */
import { eq, isNotNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { DatabaseHandles, Queryable } from '../db/client.js';
import {
  plans,
  reconciliationRuns,
  subscriptions,
} from '../db/schema/billing.js';
import type { EntitlementService } from '../entitlements/service.js';
import type { PlanCode } from '../entitlements/index.js';

export type StripeSubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'paused';

/**
 * Stripe has more statuses than we model. Anything that means "not paying and
 * not in a grace period" collapses to `incomplete`, which `effectivePlan`
 * treats as Free.
 */
export function mapStripeStatus(status: string): StripeSubscriptionStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'paused':
      return 'paused';
    default:
      return 'incomplete';
  }
}

export async function planForPriceId(
  db: Queryable,
  priceId: string | null,
): Promise<PlanCode | null> {
  if (!priceId) return null;
  const rows = await db
    .select({ code: plans.code })
    .from(plans)
    .where(eq(plans.stripePriceId, priceId))
    .limit(1);
  return (rows[0]?.code as PlanCode | undefined) ?? null;
}

export interface ProjectedSubscription {
  planCode: PlanCode;
  status: StripeSubscriptionStatus;
  seats: number;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
  canceledAt: Date | null;
}

function toDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

/** Reads a Stripe subscription object into the shape our tables hold. */
export async function projectSubscription(
  db: Queryable,
  subscription: Stripe.Subscription,
): Promise<ProjectedSubscription | null> {
  const item = subscription.items.data[0];
  const priceId = item?.price.id ?? null;
  const planCode = await planForPriceId(db, priceId);
  if (!planCode) return null;

  // Stripe moved the period fields onto the subscription item; older API
  // versions still carry them on the subscription itself.
  const periodStart =
    (item as unknown as { current_period_start?: number } | undefined)?.current_period_start ??
    (subscription as unknown as { current_period_start?: number }).current_period_start;
  const periodEnd =
    (item as unknown as { current_period_end?: number } | undefined)?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end;

  return {
    planCode,
    status: mapStripeStatus(subscription.status),
    seats: item?.quantity ?? 1,
    stripeCustomerId:
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    stripeSubscriptionId: subscription.id,
    currentPeriodStart: toDate(periodStart),
    currentPeriodEnd: toDate(periodEnd),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    trialEnd: toDate(subscription.trial_end),
    canceledAt: toDate(subscription.canceled_at),
  };
}

export interface ApplyResult {
  changed: boolean;
  subjectUserId: string | null;
  planCode: PlanCode;
}

/**
 * Writes the projection and refreshes the affected entitlement snapshots.
 *
 * The subject is whichever of `user_id` / `org_id` the existing row carries; a
 * subscription with neither cannot be applied and is reported as unmatched, so
 * the nightly job surfaces it instead of silently discarding a payment.
 */
export async function applyProjection(
  db: DatabaseHandles,
  entitlements: EntitlementService,
  projection: ProjectedSubscription,
): Promise<ApplyResult & { matched: boolean }> {
  const existing = await db.primary
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      orgId: subscriptions.orgId,
      planCode: subscriptions.planCode,
      status: subscriptions.status,
      seats: subscriptions.seats,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, projection.stripeSubscriptionId))
    .limit(1);

  const row = existing[0];
  if (!row) {
    return { matched: false, changed: false, subjectUserId: null, planCode: projection.planCode };
  }

  const changed =
    row.planCode !== projection.planCode ||
    row.status !== projection.status ||
    row.seats !== projection.seats ||
    row.cancelAtPeriodEnd !== projection.cancelAtPeriodEnd ||
    (row.currentPeriodEnd?.getTime() ?? null) !== (projection.currentPeriodEnd?.getTime() ?? null);

  await db.primary
    .update(subscriptions)
    .set({
      planCode: projection.planCode,
      status: projection.status,
      seats: projection.seats,
      stripeCustomerId: projection.stripeCustomerId,
      currentPeriodStart: projection.currentPeriodStart,
      currentPeriodEnd: projection.currentPeriodEnd,
      cancelAtPeriodEnd: projection.cancelAtPeriodEnd,
      trialEnd: projection.trialEnd,
      canceledAt: projection.canceledAt,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, row.id));

  // Entitlements are materialised per user; an org subscription changes them for
  // every seated member.
  if (row.userId) {
    await entitlements.recompute(row.userId);
  } else if (row.orgId) {
    await recomputeOrgMembers(db, entitlements, row.orgId);
  }

  return {
    matched: true,
    changed,
    subjectUserId: row.userId,
    planCode: projection.planCode,
  };
}

async function recomputeOrgMembers(
  db: DatabaseHandles,
  entitlements: EntitlementService,
  orgId: string,
): Promise<void> {
  const { orgMembers } = await import('../db/schema/identity.js');
  const members = await db.primary
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(eq(orgMembers.orgId, orgId));

  for (const member of members) {
    await entitlements.recompute(member.userId);
  }
}

export interface ReconciliationSummary {
  runId: string;
  checked: number;
  drift: number;
  repaired: number;
  unmatched: string[];
  errors: string[];
}

/**
 * The nightly sweep. Replays every subscription we believe exists against
 * Stripe's copy and repairs anything that has drifted — a webhook we never
 * received, an event we processed out of order, a manual change in the Stripe
 * dashboard.
 */
export async function reconcileSubscriptions(
  db: DatabaseHandles,
  stripe: Stripe,
  entitlements: EntitlementService,
): Promise<ReconciliationSummary> {
  const started = await db.primary
    .insert(reconciliationRuns)
    .values({ startedAt: new Date() })
    .returning({ id: reconciliationRuns.id });

  const runId = started[0]?.id as string;

  const rows = await db.primary
    .select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(isNotNull(subscriptions.stripeSubscriptionId));

  let checked = 0;
  let drift = 0;
  let repaired = 0;
  const unmatched: string[] = [];
  const errors: string[] = [];

  for (const row of rows) {
    const id = row.stripeSubscriptionId;
    if (!id) continue;
    checked += 1;

    try {
      const remote = await stripe.subscriptions.retrieve(id);
      const projection = await projectSubscription(db.primary, remote);
      if (!projection) {
        unmatched.push(id);
        continue;
      }

      const applied = await applyProjection(db, entitlements, projection);
      if (!applied.matched) {
        unmatched.push(id);
        continue;
      }
      if (applied.changed) {
        drift += 1;
        repaired += 1;
      }
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await db.primary
    .update(reconciliationRuns)
    .set({
      finishedAt: new Date(),
      subscriptionsChecked: checked,
      driftFound: drift,
      driftRepaired: repaired,
      error: errors.length > 0 ? errors.slice(0, 20).join('; ').slice(0, 4_000) : null,
    })
    .where(eq(reconciliationRuns.id, runId));

  return { runId, checked, drift, repaired, unmatched, errors };
}

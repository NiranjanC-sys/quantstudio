/**
 * Materialises the pure §7 matrix against the database.
 *
 * `billing.entitlements` is the source of truth for feature checks; this service
 * is the only thing that writes it. A per-user stamp in Redis lets a live
 * session notice that its cached snapshot went stale without re-reading Postgres
 * on every request.
 */
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { DatabaseHandles, Queryable } from '../db/client.js';
import { creditBalances, entitlements as entitlementsTable, subscriptions } from '../db/schema/billing.js';
import { mastery } from '../db/schema/progress.js';
import { streaks } from '../db/schema/progress.js';
import { orgMembers, users } from '../db/schema/identity.js';
import { keys } from '../redis/scripts.js';
import { startCreditPeriod } from './credits.js';
import {
  entitlementsFor,
  freeSubscription,
  type Entitlements,
  type PlanCode,
  type SubscriptionState,
  type SubscriptionStatus,
} from './index.js';

export interface ResolvedEntitlements {
  entitlements: Entitlements;
  /** Changes whenever the snapshot changes; compared against the session copy. */
  stamp: string;
}

export interface EntitlementService {
  /** Reads the materialised snapshot, computing and storing it if absent. */
  resolve(userId: string): Promise<ResolvedEntitlements>;
  /** Recomputes from subscription state and writes it back. */
  recompute(userId: string, tx?: Queryable): Promise<ResolvedEntitlements>;
  /** Current stamp, for cheap staleness checks on a cached session copy. */
  stamp(userId: string): Promise<string>;
  /** Creates the per-user rows a new account needs. */
  provisionNewUser(tx: Queryable, userId: string): Promise<void>;
}

/** The subscription that actually governs a user: their own, else their org's. */
export async function loadSubscriptionState(
  db: Queryable,
  userId: string,
): Promise<SubscriptionState> {
  const own = await db
    .select({
      planCode: subscriptions.planCode,
      status: subscriptions.status,
      seats: subscriptions.seats,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  const ownRow = own[0];
  if (ownRow) {
    return {
      planCode: ownRow.planCode as PlanCode,
      status: ownRow.status as SubscriptionStatus,
      seats: ownRow.seats,
      currentPeriodEnd: ownRow.currentPeriodEnd,
      cancelAtPeriodEnd: ownRow.cancelAtPeriodEnd,
    };
  }

  // Seat-based plans: only a member holding an assigned seat inherits the plan.
  const viaOrg = await db
    .select({
      planCode: subscriptions.planCode,
      status: subscriptions.status,
      seats: subscriptions.seats,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    })
    .from(users)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, users.id), eq(orgMembers.seatAssigned, true)),
    )
    .innerJoin(subscriptions, eq(subscriptions.orgId, orgMembers.orgId))
    .where(eq(users.id, userId))
    .limit(1);

  const orgRow = viaOrg[0];
  if (orgRow) {
    return {
      planCode: orgRow.planCode as PlanCode,
      status: orgRow.status as SubscriptionStatus,
      seats: orgRow.seats,
      currentPeriodEnd: orgRow.currentPeriodEnd,
      cancelAtPeriodEnd: orgRow.cancelAtPeriodEnd,
    };
  }

  return freeSubscription();
}

function monthEnd(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}

export function createEntitlementService(
  db: DatabaseHandles,
  redis: Redis,
): EntitlementService {
  async function bumpStamp(userId: string, stamp: string): Promise<void> {
    // 15 minutes is long enough to serve a session's lifetime of requests and
    // short enough that a lost invalidation self-heals quickly.
    await redis.set(keys.entitlementCache(userId), stamp, 'EX', 900);
  }

  async function write(
    tx: Queryable,
    userId: string,
    state: SubscriptionState,
  ): Promise<ResolvedEntitlements> {
    const computed = entitlementsFor(state);
    const stamp = `${computed.plan}:${Date.now()}`;

    await tx
      .insert(entitlementsTable)
      .values({
        userId,
        planCode: computed.plan,
        snapshot: computed as unknown as Record<string, unknown>,
        source: state.planCode === 'free' ? 'default' : 'subscription',
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: entitlementsTable.userId,
        set: {
          planCode: computed.plan,
          snapshot: computed as unknown as Record<string, unknown>,
          source: state.planCode === 'free' ? 'default' : 'subscription',
          computedAt: new Date(),
        },
      });

    await bumpStamp(userId, stamp);
    return { entitlements: computed, stamp };
  }

  return {
    async resolve(userId) {
      const rows = await db.replica
        .select({ snapshot: entitlementsTable.snapshot, computedAt: entitlementsTable.computedAt })
        .from(entitlementsTable)
        .where(eq(entitlementsTable.userId, userId))
        .limit(1);

      const row = rows[0];
      if (!row) {
        return this.recompute(userId);
      }

      const cached = await redis.get(keys.entitlementCache(userId));
      const snapshot = row.snapshot as unknown as Entitlements;
      const stamp = cached ?? `${snapshot.plan}:${row.computedAt.getTime()}`;
      if (!cached) await bumpStamp(userId, stamp);

      return { entitlements: snapshot, stamp };
    },

    async recompute(userId, tx) {
      const handle = tx ?? db.primary;
      const state = await loadSubscriptionState(handle, userId);
      return write(handle, userId, state);
    },

    async stamp(userId) {
      const cached = await redis.get(keys.entitlementCache(userId));
      if (cached) return cached;
      const { stamp } = await this.resolve(userId);
      return stamp;
    },

    /**
     * Everything a new account needs before its first request: the mastery row
     * that carries the unlocked-lesson array, a streak row, a credit balance
     * seeded with the Free monthly grant, and the entitlement snapshot.
     */
    async provisionNewUser(tx, userId) {
      const now = new Date();
      const periodEnd = monthEnd(now);

      await tx.insert(mastery).values({ userId }).onConflictDoNothing();
      await tx.insert(streaks).values({ userId }).onConflictDoNothing();
      await tx
        .insert(creditBalances)
        .values({ userId, balance: 0, periodStart: now, periodEnd })
        .onConflictDoNothing();

      const state = freeSubscription();
      const computed = entitlementsFor(state, now);
      await write(tx, userId, state);

      if (computed.simCreditsPerMonth !== null && computed.simCreditsPerMonth > 0) {
        await startCreditPeriod(tx, {
          userId,
          credits: computed.simCreditsPerMonth,
          periodStart: now,
          periodEnd,
          idempotencyKey: `signup:${userId}`,
        });
      }
    },
  };
}

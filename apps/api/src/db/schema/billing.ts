/**
 * `billing` schema — system-design §7.
 *
 * `entitlements` is the source of truth for feature checks: no request path ever
 * calls Stripe (§7, §9 step 5). `credit_ledger` is append-only — enforced by the
 * trigger in `0001_partitions.sql` — and `credit_balances` is its materialised
 * balance, written in the same transaction as the ledger row and as the job
 * enqueue, so a job can never run uncharged.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgs, users } from './identity.js';

export const billing = pgSchema('billing');

export const planCode = billing.enum('plan_code', ['free', 'pro', 'teams', 'campus']);
export const subscriptionStatus = billing.enum('subscription_status', [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'paused',
]);
export const creditReason = billing.enum('credit_reason', [
  'monthly_grant',
  'plan_change_grant',
  'promotional_grant',
  'simulation',
  'lab',
  'contest',
  'refund',
  'adjustment',
  'expiry',
]);
export const stripeEventStatus = billing.enum('stripe_event_status', [
  'received',
  'processed',
  'failed',
  'ignored',
]);

export const plans = billing.table(
  'plans',
  {
    code: planCode('code').primaryKey(),
    name: text('name').notNull(),
    /** Cents. Campus is negotiated, so 0 here and priced per contract. */
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    interval: text('interval').notNull(),
    seatBased: boolean('seat_based').notNull().default(false),
    stripePriceId: text('stripe_price_id'),
    /** The §7 matrix, verbatim; `entitlementsFor()` is the authority at runtime. */
    features: jsonb('features').$type<Record<string, unknown>>().notNull(),
    position: integer('position').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    uniqueIndex('plans_position_key').on(t.position),
    uniqueIndex('plans_stripe_price_key').on(t.stripePriceId),
    check('plans_price_nonneg', sql`${t.priceCents} >= 0`),
    check('plans_interval_valid', sql`${t.interval} in ('month', 'year', 'none')`),
  ],
);

export const subscriptions = billing.table(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Exactly one of `user_id` / `org_id` is set. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    planCode: planCode('plan_code')
      .notNull()
      .references(() => plans.code),
    status: subscriptionStatus('status').notNull(),
    seats: integer('seats').notNull().default(1),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true, mode: 'date' }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true, mode: 'date' }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    trialEnd: timestamp('trial_end', { withTimezone: true, mode: 'date' }),
    canceledAt: timestamp('canceled_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscriptions_stripe_subscription_key').on(t.stripeSubscriptionId),
    uniqueIndex('subscriptions_user_key').on(t.userId).where(sql`${t.userId} is not null`),
    uniqueIndex('subscriptions_org_key').on(t.orgId).where(sql`${t.orgId} is not null`),
    index('subscriptions_status_idx').on(t.status),
    check(
      'subscriptions_exactly_one_subject',
      sql`(${t.userId} is not null) <> (${t.orgId} is not null)`,
    ),
    check('subscriptions_seats_positive', sql`${t.seats} >= 1`),
    check(
      'subscriptions_period_ordered',
      sql`${t.currentPeriodEnd} is null or ${t.currentPeriodStart} is null or ${t.currentPeriodEnd} > ${t.currentPeriodStart}`,
    ),
  ],
);

/**
 * Materialised §7 matrix per user. Recomputed whenever a subscription changes and
 * by the nightly Stripe reconciliation job; read on every request from the
 * session cache, so a Stripe outage cannot deny a paying user their features.
 */
export const entitlements = billing.table(
  'entitlements',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    planCode: planCode('plan_code')
      .notNull()
      .references(() => plans.code),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    source: text('source').notNull().default('subscription'),
    computedAt: timestamp('computed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('entitlements_plan_idx').on(t.planCode),
    check('entitlements_source_valid', sql`${t.source} in ('subscription', 'org_seat', 'default', 'reconciliation')`),
  ],
);

/**
 * Append-only. `delta` is negative for a debit. `balance_after` is written by the
 * same statement that updates `credit_balances`, which makes the ledger
 * self-auditing: replaying it must reproduce the materialised balance.
 */
export const creditLedger = billing.table(
  'credit_ledger',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'set null' }),
    delta: integer('delta').notNull(),
    reason: creditReason('reason').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    /** Makes a retried enqueue a no-op rather than a double charge. */
    idempotencyKey: text('idempotency_key'),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_ledger_user_created_idx').on(t.userId, t.createdAt),
    uniqueIndex('credit_ledger_idempotency_key').on(t.userId, t.idempotencyKey),
    check('credit_ledger_delta_nonzero', sql`${t.delta} <> 0`),
    check('credit_ledger_balance_nonneg', sql`${t.balanceAfter} >= 0`),
  ],
);

export const creditBalances = billing.table(
  'credit_balances',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    balance: integer('balance').notNull().default(0),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
    grantedThisPeriod: integer('granted_this_period').notNull().default(0),
    consumedThisPeriod: integer('consumed_this_period').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('credit_balances_nonneg', sql`${t.balance} >= 0 and ${t.grantedThisPeriod} >= 0 and ${t.consumedThisPeriod} >= 0`),
    check('credit_balances_period_ordered', sql`${t.periodEnd} > ${t.periodStart}`),
  ],
);

export const invoices = billing.table(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeInvoiceId: text('stripe_invoice_id').notNull(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'set null' }),
    amountDue: integer('amount_due').notNull(),
    amountPaid: integer('amount_paid').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    status: text('status').notNull(),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invoices_stripe_invoice_key').on(t.stripeInvoiceId),
    index('invoices_user_idx').on(t.userId),
    check('invoices_amounts_nonneg', sql`${t.amountDue} >= 0 and ${t.amountPaid} >= 0`),
  ],
);

/** §7: webhook idempotency is a unique index on `stripe_event_id`, nothing cleverer. */
export const stripeEvents = billing.table(
  'stripe_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeEventId: text('stripe_event_id').notNull(),
    type: text('type').notNull(),
    apiVersion: text('api_version'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: stripeEventStatus('status').notNull().default('received'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('stripe_events_event_id_key').on(t.stripeEventId),
    index('stripe_events_status_idx').on(t.status).where(sql`${t.status} <> 'processed'`),
  ],
);

/** Audit trail for the nightly job that replays Stripe state (§7). */
export const reconciliationRuns = billing.table(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    subscriptionsChecked: integer('subscriptions_checked').notNull().default(0),
    driftFound: integer('drift_found').notNull().default(0),
    driftRepaired: integer('drift_repaired').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('reconciliation_runs_started_idx').on(t.startedAt)],
);

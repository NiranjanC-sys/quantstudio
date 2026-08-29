/**
 * Billing (system-design §7).
 *
 * Three rules shape this module:
 *
 *  - No request path calls Stripe to decide anything. Feature checks read
 *    `billing.entitlements`, which is why §9 step 5 ("Stripe down → entitlements
 *    keep working from the cached table") is true rather than aspirational.
 *  - Webhooks are idempotent through a unique index on `stripe_event_id`. The
 *    insert *is* the lock: a duplicate delivery loses the insert and returns 200
 *    without reprocessing.
 *  - Signature verification happens against the raw body, so the webhook route
 *    lives in its own encapsulated scope with a buffer content-type parser.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type Stripe from 'stripe';
import { z } from 'zod';
import {
  creditLedger,
  invoices,
  plans,
  reconciliationRuns,
  stripeEvents,
  subscriptions,
} from '../db/schema/billing.js';
import { users } from '../db/schema/identity.js';
import { currentBalance } from '../entitlements/credits.js';
import { ApiError, problem } from '../errors.js';
import {
  applyProjection,
  projectSubscription,
  reconcileSubscriptions,
} from '../billing/reconcile.js';
import {
  authed,
  page,
  paginationSchema,
  rateLimit,
  readBody,
  readQuery,
  useIdempotency,
} from './helpers.js';

const checkoutSchema = z.object({
  plan: z.enum(['pro', 'teams', 'campus']),
  seats: z.number().int().min(1).max(10_000).default(1),
  successUrl: z.string().url().max(2048).optional(),
  cancelUrl: z.string().url().max(2048).optional(),
});

/** Events we act on. Everything else is recorded and marked `ignored`. */
const HANDLED_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

export const billingRoutes: FastifyPluginAsync = async (app) => {
  const { db, env, stripe, entitlements: entitlementService, queues } = app.services;

  useIdempotency(app);
  const readLimit = rateLimit(app, 'read');
  const writeLimit = rateLimit(app, 'write');

  function requireStripe(): Stripe {
    if (!stripe) {
      throw new ApiError('upstream-unavailable', 'Billing is not configured on this deployment.', {
        extensions: { service: 'stripe' },
      });
    }
    return stripe;
  }

  app.get('/plans', { preHandler: [readLimit] }, async (_request, reply) => {
    const rows = await db.replica
      .select({
        code: plans.code,
        name: plans.name,
        priceCents: plans.priceCents,
        currency: plans.currency,
        interval: plans.interval,
        seatBased: plans.seatBased,
        features: plans.features,
        position: plans.position,
      })
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(plans.position);

    return reply.header('cache-control', 'public, max-age=300').send({ items: rows });
  });

  app.get('/subscription', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);

    const rows = await db.read(request.readFromPrimary)
      .select({
        id: subscriptions.id,
        planCode: subscriptions.planCode,
        status: subscriptions.status,
        seats: subscriptions.seats,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        trialEnd: subscriptions.trialEnd,
      })
      .from(subscriptions)
      .where(eq(subscriptions.userId, auth.userId))
      .limit(1);

    return reply.send({
      subscription: rows[0] ?? null,
      // The entitlement snapshot, not Stripe, is what the product enforces.
      entitlements: request.entitlements ?? auth.entitlements,
      plan: auth.plan,
    });
  });

  app.get('/credits', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const query = readQuery(request, paginationSchema);

    const ledger = await db.read(request.readFromPrimary)
      .select({
        id: creditLedger.id,
        delta: creditLedger.delta,
        reason: creditLedger.reason,
        refType: creditLedger.refType,
        refId: creditLedger.refId,
        balanceAfter: creditLedger.balanceAfter,
        createdAt: creditLedger.createdAt,
      })
      .from(creditLedger)
      .where(eq(creditLedger.userId, auth.userId))
      .orderBy(desc(creditLedger.id))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.read(request.readFromPrimary)
      .select({ total: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.userId, auth.userId));

    return reply.send({
      balance: await currentBalance(db.read(request.readFromPrimary), auth.userId),
      monthlyGrant: (request.entitlements ?? auth.entitlements).simCreditsPerMonth,
      ...page(
        ledger.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
        query,
        counted[0]?.total ?? 0,
      ),
    });
  });

  app.get('/invoices', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const query = readQuery(request, paginationSchema);

    const rows = await db.read(request.readFromPrimary)
      .select()
      .from(invoices)
      .where(eq(invoices.userId, auth.userId))
      .orderBy(desc(invoices.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.read(request.readFromPrimary)
      .select({ total: sql<number>`count(*)::int` })
      .from(invoices)
      .where(eq(invoices.userId, auth.userId));

    return reply.send(page(rows, query, counted[0]?.total ?? 0));
  });

  // ------------------------------------------------------------- checkout

  app.post('/checkout', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const input = readBody(request, checkoutSchema);
    const client = requireStripe();

    const planRows = await db.primary
      .select({ code: plans.code, stripePriceId: plans.stripePriceId, seatBased: plans.seatBased })
      .from(plans)
      .where(and(eq(plans.code, input.plan), eq(plans.active, true)))
      .limit(1);

    const plan = planRows[0];
    if (!plan) throw problem.notFound('Plan');
    if (!plan.stripePriceId) {
      throw new ApiError(
        'conflict',
        `The ${input.plan} plan has no Stripe price configured; it is sold by contract.`,
      );
    }

    const existing = await db.primary
      .select({ stripeCustomerId: subscriptions.stripeCustomerId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, auth.userId))
      .limit(1);

    const customerId = existing[0]?.stripeCustomerId ?? undefined;

    const session = await client.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        { price: plan.stripePriceId, quantity: plan.seatBased ? input.seats : 1 },
      ],
      ...(customerId ? { customer: customerId } : { customer_email: auth.email }),
      success_url: input.successUrl ?? `${env.WEB_PUBLIC_URL}/billing/success?session={CHECKOUT_SESSION_ID}`,
      cancel_url: input.cancelUrl ?? `${env.WEB_PUBLIC_URL}/billing/cancelled`,
      // Carried through to the webhook, which is the only place that is allowed
      // to grant a plan.
      client_reference_id: auth.userId,
      subscription_data: { metadata: { userId: auth.userId, planCode: plan.code } },
      metadata: { userId: auth.userId, planCode: plan.code },
      allow_promotion_codes: true,
    });

    return reply.status(201).send({ id: session.id, url: session.url });
  });

  app.post('/portal', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    const client = requireStripe();

    const rows = await db.primary
      .select({ stripeCustomerId: subscriptions.stripeCustomerId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, auth.userId))
      .limit(1);

    const customerId = rows[0]?.stripeCustomerId;
    if (!customerId) {
      throw new ApiError('conflict', 'You do not have a billing account yet.');
    }

    const session = await client.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${env.WEB_PUBLIC_URL}/billing`,
    });

    return reply.status(201).send({ url: session.url });
  });

  // ---------------------------------------------------------- reconciliation

  /**
   * The nightly job (§7) is a BullMQ repeatable; this exposes the same routine
   * so an operator can force a replay after an incident.
   */
  app.post('/reconcile', { preHandler: [writeLimit] }, async (request, reply) => {
    const auth = authed(request);
    if (auth.role !== 'admin') throw problem.forbidden('Only an admin can force reconciliation.');

    const { async: runAsync } = readBody(
      request,
      z.object({ async: z.boolean().default(false) }),
    );

    if (runAsync) {
      await queues.billing.add('reconcile', {
        kind: 'reconcile',
        runDate: new Date().toISOString().slice(0, 10),
      });
      return reply.status(202).send({ queued: true });
    }

    const summary = await reconcileSubscriptions(db, requireStripe(), entitlementService);
    return reply.send(summary);
  });

  app.get('/reconcile/runs', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    if (auth.role !== 'admin') throw problem.forbidden('Only an admin can read reconciliation runs.');
    const query = readQuery(request, paginationSchema);

    const rows = await db.replica
      .select()
      .from(reconciliationRuns)
      .orderBy(desc(reconciliationRuns.startedAt))
      .limit(query.limit)
      .offset(query.offset);

    return reply.send({ items: rows });
  });

  // ---------------------------------------------------------------- webhook

  /**
   * Encapsulated so the buffer content-type parser applies to this route and
   * nothing else: Stripe signatures are computed over the exact bytes, and a
   * JSON round trip through `JSON.parse`/`stringify` would invalidate them.
   */
  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    webhookScope.post('/webhook', async (request, reply) => {
      const client = requireStripe();
      if (!env.STRIPE_WEBHOOK_SECRET) {
        throw new ApiError('upstream-unavailable', 'Stripe webhook secret is not configured.');
      }

      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        throw new ApiError('unauthorized', 'Missing Stripe-Signature header.');
      }

      const raw = request.body;
      if (!Buffer.isBuffer(raw)) {
        throw new ApiError('validation-failed', 'Webhook body must be raw JSON bytes.');
      }

      let event: Stripe.Event;
      try {
        event = client.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET);
      } catch (error) {
        throw new ApiError('unauthorized', 'Stripe signature verification failed.', {
          cause: error,
        });
      }

      // §7: idempotency is a unique index on `stripe_event_id`, nothing cleverer.
      // Losing this insert means another delivery already has the event.
      const claimed = await db.primary
        .insert(stripeEvents)
        .values({
          stripeEventId: event.id,
          type: event.type,
          apiVersion: event.api_version ?? null,
          payload: event as unknown as Record<string, unknown>,
          status: 'received',
          attempts: 1,
        })
        .onConflictDoNothing({ target: stripeEvents.stripeEventId })
        .returning({ id: stripeEvents.id });

      if (claimed.length === 0) {
        return reply.send({ received: true, duplicate: true });
      }

      const recordId = claimed[0]?.id as string;

      if (!HANDLED_EVENTS.has(event.type)) {
        await db.primary
          .update(stripeEvents)
          .set({ status: 'ignored', processedAt: new Date() })
          .where(eq(stripeEvents.id, recordId));
        return reply.send({ received: true, handled: false });
      }

      try {
        await handleEvent(event);
        await db.primary
          .update(stripeEvents)
          .set({ status: 'processed', processedAt: new Date() })
          .where(eq(stripeEvents.id, recordId));
        return reply.send({ received: true, handled: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.primary
          .update(stripeEvents)
          .set({ status: 'failed', error: message.slice(0, 4_000) })
          .where(eq(stripeEvents.id, recordId));
        // 500 so Stripe retries; the row stays `failed` and the nightly
        // reconciliation repairs the state even if every retry fails.
        throw new ApiError('internal-error', 'Webhook processing failed.', { cause: error });
      }
    });
  });

  async function upsertSubscriptionForUser(
    userId: string,
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const projection = await projectSubscription(db.primary, subscription);
    if (!projection) return;

    await db.primary
      .insert(subscriptions)
      .values({
        userId,
        planCode: projection.planCode,
        status: projection.status,
        seats: projection.seats,
        stripeCustomerId: projection.stripeCustomerId,
        stripeSubscriptionId: projection.stripeSubscriptionId,
        currentPeriodStart: projection.currentPeriodStart,
        currentPeriodEnd: projection.currentPeriodEnd,
        cancelAtPeriodEnd: projection.cancelAtPeriodEnd,
        trialEnd: projection.trialEnd,
        canceledAt: projection.canceledAt,
      })
      .onConflictDoUpdate({
        target: subscriptions.stripeSubscriptionId,
        set: {
          planCode: projection.planCode,
          status: projection.status,
          seats: projection.seats,
          currentPeriodStart: projection.currentPeriodStart,
          currentPeriodEnd: projection.currentPeriodEnd,
          cancelAtPeriodEnd: projection.cancelAtPeriodEnd,
          trialEnd: projection.trialEnd,
          canceledAt: projection.canceledAt,
          updatedAt: new Date(),
        },
      });

    await entitlementService.recompute(userId);
  }

  async function handleEvent(event: Stripe.Event): Promise<void> {
    const client = requireStripe();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId =
          session.client_reference_id ??
          (typeof session.metadata?.['userId'] === 'string' ? session.metadata['userId'] : null);
        if (!userId || !session.subscription) return;

        const subscriptionId =
          typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const subscription = await client.subscriptions.retrieve(subscriptionId);
        await upsertSubscriptionForUser(userId, subscription);
        return;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const projection = await projectSubscription(db.primary, subscription);
        if (!projection) return;

        const applied = await applyProjection(db, entitlementService, projection);
        if (applied.matched) return;

        // A subscription we have never seen: attach it to the user named in the
        // metadata, which checkout always sets.
        const userId = subscription.metadata?.['userId'];
        if (typeof userId === 'string') {
          const exists = await db.primary
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (exists.length > 0) await upsertSubscriptionForUser(userId, subscription);
        }
        return;
      }

      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId =
          typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;

        const owner = customerId
          ? await db.primary
              .select({ userId: subscriptions.userId, orgId: subscriptions.orgId, id: subscriptions.id })
              .from(subscriptions)
              .where(eq(subscriptions.stripeCustomerId, customerId))
              .limit(1)
          : [];

        await db.primary
          .insert(invoices)
          .values({
            stripeInvoiceId: invoice.id as string,
            subscriptionId: owner[0]?.id ?? null,
            userId: owner[0]?.userId ?? null,
            orgId: owner[0]?.orgId ?? null,
            amountDue: invoice.amount_due,
            amountPaid: invoice.amount_paid,
            currency: invoice.currency,
            status: invoice.status ?? 'open',
            hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
            periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
            periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
          })
          .onConflictDoNothing({ target: invoices.stripeInvoiceId });

        // §7: a failed invoice does not immediately downgrade anyone —
        // `effectivePlan` keeps `past_due` working through the grace window.
        if (owner[0]?.userId) await entitlementService.recompute(owner[0].userId);
        return;
      }

      default:
        return;
    }
  }
};

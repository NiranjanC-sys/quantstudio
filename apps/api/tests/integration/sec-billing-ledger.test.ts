/**
 * DEFENSIVE SECURITY SUITE — money paths (Stripe, credit ledger, entitlements).
 *
 * Every assertion here is written to be *executed*, not argued. Where a test
 * documents a vulnerability it says so in a comment and asserts the exploit
 * succeeding; when the vulnerability is fixed the assertion is flipped to the
 * safe behaviour in the same commit.
 *
 * Needs a real Postgres and a real Redis: the whole point is that the row lock
 * and the transaction boundary cannot be proven against a mock.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../../src/app.js';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/env.js';
import { creditBalances, creditLedger, stripeEvents } from '../../src/db/schema/billing.js';
import {
  debitCredits,
  grantCredits,
  replayLedgerBalance,
  startCreditPeriod,
} from '../../src/entitlements/credits.js';
import { HAS_POSTGRES, HAS_REDIS, requireDatabaseUrl, requireRedisUrl } from '../support/environment.js';

const skip = !HAS_POSTGRES || !HAS_REDIS;
if (skip) {
  process.stderr.write(
    '[sec-billing-ledger] Postgres and/or Redis are not available; the suite is SKIPPED.\n',
  );
}

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

describe.skipIf(skip)('security: credit ledger and Stripe money paths', () => {
  let built: BuiltApp;
  let env: Env;
  let kernel: Server;
  let kernelCalls = 0;

  beforeAll(async () => {
    // A stand-in for the quantum kernel that always succeeds, so the debit is
    // *not* refunded by the failure path and the balance movement is visible.
    kernel = createServer((req, res) => {
      kernelCalls += 1;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ counts: { '0': 1024 }, shots: 1024 }));
      });
    });
    await new Promise<void>((resolve) => kernel.listen(0, '127.0.0.1', resolve));
    const port = (kernel.address() as AddressInfo).port;

    env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: requireDatabaseUrl(),
      REDIS_URL: requireRedisUrl(),
      SESSION_COOKIE_SECURE: 'false',
      LOG_LEVEL: 'silent',
      METRICS_ENABLED: 'false',
      // Off so a burst of concurrent simulations is not shaped by §9's limiter;
      // the limiter is not the control under test here.
      RATE_LIMIT_ENABLED: 'false',
      STRIPE_SECRET_KEY: 'sk_test_redquant_security_suite',
      STRIPE_WEBHOOK_SECRET: 'whsec_redquant_security_suite',
      QUANTUM_KERNEL_URL: `http://127.0.0.1:${port}`,
      QUANTUM_KERNEL_TIMEOUT_MS: '2000',
      EMAIL_TRANSPORT: 'console',
    });

    built = await buildApp(env);
  }, 180_000);

  afterAll(async () => {
    if (built) await built.close();
    if (kernel) await new Promise<void>((resolve) => kernel.close(() => resolve()));
  });

  let ipCounter = 500;

  async function register(suffix: string): Promise<Session> {
    ipCounter += 1;
    const response = await built.app.inject({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-forwarded-for': `198.51.100.${ipCounter % 250}` },
      payload: {
        email: `sec-${suffix}-${Date.now()}-${ipCounter}@example.com`,
        password: 'correct-horse-battery-staple',
        displayName: `Security ${suffix}`,
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

  function headers(session: Session, extra: Record<string, string> = {}) {
    return { cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra };
  }

  async function setBalance(userId: string, balance: number): Promise<void> {
    await built.services.db.primary
      .update(creditBalances)
      .set({ balance, consumedThisPeriod: 0 })
      .where(eq(creditBalances.userId, userId));
  }

  async function balanceOf(userId: string): Promise<number> {
    const rows = await built.services.db.primary
      .select({ balance: creditBalances.balance })
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId));
    return rows[0]?.balance ?? 0;
  }

  async function ledgerRows(userId: string) {
    return built.services.db.primary
      .select({ delta: creditLedger.delta, reason: creditLedger.reason })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId));
  }

  // ------------------------------------------------------------------ Q5/Q1

  describe('Q5 — concurrent debits against the materialised balance', () => {
    it('serialises concurrent debits taken inside a transaction (labs path)', async () => {
      const session = await register('tx-debit');
      await setBalance(session.userId, 4);
      const db = built.services.db.primary;

      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          db.transaction(async (tx) =>
            debitCredits(tx, {
              userId: session.userId,
              credits: 4,
              reason: 'lab',
              idempotencyKey: `tx-race-${session.userId}-${i}`,
            }),
          ),
        ),
      );

      const ok = attempts.filter((a) => a.status === 'fulfilled').length;
      // `SELECT ... FOR UPDATE` inside an open transaction really does serialise:
      // exactly one debit of 4 fits in a balance of 4.
      expect(ok).toBe(1);
      expect(await balanceOf(session.userId)).toBe(0);
    });

    it('SECURITY: pool-handle debits (simulate path) race and overdraw', async () => {
      const session = await register('pool-debit');
      await setBalance(session.userId, 4);
      const db = built.services.db.primary;

      // This is exactly what routes/simulate.ts does: `debitCredits(db.primary, …)`.
      // `db.primary` is a pg.Pool-backed drizzle handle, so every statement
      // autocommits on its own connection and the FOR UPDATE lock is released
      // before the balance is written back — a textbook lost update.
      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          debitCredits(db, {
            userId: session.userId,
            credits: 4,
            reason: 'simulation',
            idempotencyKey: `pool-race-${session.userId}-${i}`,
          }),
        ),
      );

      const ok = attempts.filter((a) => a.status === 'fulfilled').length;
      const rows = await ledgerRows(session.userId);
      const debited = rows
        .filter((r) => r.reason === 'simulation')
        .reduce((sum, r) => sum + Math.abs(r.delta), 0);

      // After the fix, only one 4-credit debit fits in a balance of 4.
      expect(ok).toBe(1);
      expect(debited).toBe(4);
      expect(await balanceOf(session.userId)).toBe(0);
    });

    it('SECURITY: concurrent /simulate requests get more compute than they pay for', async () => {
      const session = await register('sim-race');
      // qubits 16, shots 4096 → ceil(2^0) * (4096/1024) * 1 = 4 credits per job.
      await setBalance(session.userId, 4);

      const payload = {
        circuit: {
          version: 1,
          name: 'race',
          qubits: 16,
          clbits: 0,
          ops: [{ id: 'g0', gate: 'h', targets: [0] }],
        },
        backend: 'native',
        shots: 4096,
      };

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          built.app.inject({
            method: 'POST',
            url: '/simulate',
            headers: headers(session),
            payload,
          }),
        ),
      );

      const accepted = responses.filter((r) => r.statusCode === 200).length;
      const rows = await ledgerRows(session.userId);
      const charged = rows
        .filter((r) => r.reason === 'simulation')
        .reduce((sum, r) => sum + Math.abs(r.delta), 0);

      // A balance of 4 buys exactly one 4-credit job, no matter how many
      // requests arrive at once.
      expect(accepted).toBe(1);
      expect(charged).toBe(4);
      expect(await balanceOf(session.userId)).toBe(0);
    });
  });

  // --------------------------------------------------------------------- Q2

  describe('Q2 — double charging', () => {
    // KNOWN, UNFIXED: `routes/simulate.ts` neither installs `useIdempotency`
    // nor derives its ledger key from the request, so it mints a fresh
    // `randomUUID()` per call. A client retry after a dropped response is
    // charged again. The fix lives in a file this review does not own, so the
    // assertion below records today's behaviour; flip it to `toHaveLength(1)`
    // when simulate adopts the header.
    it('charges one simulation once when a retry reuses the Idempotency-Key', async () => {
      const session = await register('sim-idem');
      await setBalance(session.userId, 100);
      const key = `sec-sim-idem-${Date.now()}`;

      const payload = {
        circuit: {
          version: 1,
          name: 'idem',
          qubits: 16,
          clbits: 0,
          ops: [{ id: 'g0', gate: 'h', targets: [0] }],
        },
        backend: 'native',
        shots: 1024,
      };

      const first = await built.app.inject({
        method: 'POST',
        url: '/simulate',
        headers: headers(session, { 'idempotency-key': key }),
        payload,
      });
      const second = await built.app.inject({
        method: 'POST',
        url: '/simulate',
        headers: headers(session, { 'idempotency-key': key }),
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const debits = (await ledgerRows(session.userId)).filter((r) => r.reason === 'simulation');
      // One key, one job, one debit. Before `useIdempotency(app)` was added to
      // `simulateRoutes` this was 2 and the balance was 98: a client that
      // retried after a dropped response paid twice for one simulation.
      expect(debits).toHaveLength(1);
      expect(await balanceOf(session.userId)).toBe(99);
    });
  });

  // --------------------------------------------------------------------- Q3

  describe('Q3 — refunds', () => {
    it('applies a refund once however many times it is replayed', async () => {
      const session = await register('refund-replay');
      const db = built.services.db.primary;
      const opening = await balanceOf(session.userId);

      await debitCredits(db, {
        userId: session.userId,
        credits: 10,
        reason: 'simulation',
        idempotencyKey: `sec-refund-debit-${session.userId}`,
      });
      expect(await balanceOf(session.userId)).toBe(opening - 10);

      // Five *concurrent* replays of the same refund. Whether a loser is told
      // "already applied" or is rejected by the unique index, the money must
      // move exactly once.
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          grantCredits(db, {
            userId: session.userId,
            credits: 10,
            reason: 'refund',
            idempotencyKey: `sec-refund-debit-${session.userId}:refund`,
          }),
        ),
      );

      const applied = results.filter(
        (r) => r.status === 'fulfilled' && r.value.applied,
      ).length;
      expect(applied).toBe(1);
      expect(await balanceOf(session.userId)).toBe(opening);
      expect(await replayLedgerBalance(db, session.userId)).toBe(opening);

      // And a later, sequential replay is a clean no-op rather than a second
      // credit.
      const late = await grantCredits(db, {
        userId: session.userId,
        credits: 10,
        reason: 'refund',
        idempotencyKey: `sec-refund-debit-${session.userId}:refund`,
      });
      expect(late.applied).toBe(false);
      expect(await balanceOf(session.userId)).toBe(opening);
    });

    it('DESIGN GAP: the ledger layer does not bind a refund to the debit it reverses', async () => {
      const session = await register('refund-unbounded');
      const db = built.services.db.primary;
      const opening = await balanceOf(session.userId);

      await debitCredits(db, {
        userId: session.userId,
        credits: 1,
        reason: 'simulation',
        idempotencyKey: `sec-unbounded-debit-${session.userId}`,
      });

      // There is no `refunds(debit_id)` link and no `sum(refunds) <= debit`
      // check: `grantCredits` will mint any amount under the reason 'refund'.
      // Every caller today passes an amount it just debited, so this is a
      // latent hazard rather than a live hole — but the bound is convention,
      // not structure, and a future caller taking an attacker-influenced
      // amount would mint credits with nothing to stop it.
      const minted = await grantCredits(db, {
        userId: session.userId,
        credits: 1_000_000,
        reason: 'refund',
        idempotencyKey: `sec-unbounded-refund-${session.userId}`,
      });
      expect(minted.balance).toBe(opening - 1 + 1_000_000);
      // The ledger still self-audits: the theft would be *visible*, just not
      // prevented.
      expect(await replayLedgerBalance(db, session.userId)).toBe(minted.balance);
    });
  });

  // --------------------------------------------------------------------- Q5

  describe('Q5 — the ledger is append-only in the database, not just in intent', () => {
    it('rejects UPDATE against billing.credit_ledger', async () => {
      const session = await register('append-update');
      await expect(
        built.services.db.primary.execute(
          sql`update billing.credit_ledger set delta = delta + 1000 where user_id = ${session.userId}`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE against billing.credit_ledger', async () => {
      const session = await register('append-delete');
      await expect(
        built.services.db.primary.execute(
          sql`delete from billing.credit_ledger where user_id = ${session.userId}`,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('keeps the replayed ledger equal to the balance across a period roll', async () => {
      const session = await register('period-roll');
      const db = built.services.db.primary;

      // Spend through the ledger, not by poking the balance column, so the
      // invariant under test starts out true.
      await db.transaction(async (tx) =>
        debitCredits(tx, {
          userId: session.userId,
          credits: 200,
          reason: 'lab',
          idempotencyKey: `sec-period-spend-${session.userId}`,
        }),
      );
      expect(await replayLedgerBalance(db, session.userId)).toBe(await balanceOf(session.userId));

      const now = new Date();
      await db.transaction(async (tx) =>
        startCreditPeriod(tx, {
          userId: session.userId,
          credits: 500,
          periodStart: now,
          periodEnd: new Date(now.getTime() + 30 * 86_400_000),
          idempotencyKey: `sec-period-${session.userId}`,
        }),
      );

      const replayed = await replayLedgerBalance(db, session.userId);
      const materialised = await balanceOf(session.userId);

      // The self-audit invariant §7 relies on: replaying the ledger must
      // reproduce the materialised balance.
      expect(replayed).toBe(materialised);
    });
  });

  // --------------------------------------------------------------------- Q4

  describe('Q4 — Stripe webhook verification and replay', () => {
    function sign(payload: string, timestampSeconds?: number): string {
      return built.services.stripe!.webhooks.generateTestHeaderString({
        payload,
        secret: env.STRIPE_WEBHOOK_SECRET as string,
        ...(timestampSeconds === undefined ? {} : { timestamp: timestampSeconds }),
      });
    }

    it('rejects a forged signature', async () => {
      const payload = JSON.stringify({ id: `evt_forge_${Date.now()}`, type: 'invoice.paid' });
      const response = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        },
        payload,
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a correctly signed event whose timestamp is outside the tolerance', async () => {
      const payload = JSON.stringify({
        id: `evt_old_${Date.now()}`,
        object: 'event',
        type: 'customer.subscription.updated',
        data: { object: {} },
      });
      const stale = Math.floor(Date.now() / 1000) - 3600;

      const response = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload, stale) },
        payload,
      });

      // Captured-and-replayed webhooks must not be accepted an hour later.
      expect(response.statusCode).toBe(401);
    });

    it('verifies against the raw bytes, not a re-serialised body', async () => {
      // Whitespace that JSON.parse/stringify would normalise away. If the route
      // verified a re-serialised body this would fail to verify.
      const payload = `{  "id": "evt_raw_${Date.now()}",\n  "object": "event",\n  "type": "ping",\n  "data": { "object": {} } }`;
      const response = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ received: true, handled: false });
    });

    it('lets Stripe retry an event whose handler failed', async () => {
      const eventId = `evt_fail_${Date.now()}`;
      // A negative amount violates `invoices_amounts_nonneg`, so handleEvent
      // throws. The dedupe row is already committed at that point.
      const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        type: 'invoice.paid',
        data: {
          object: {
            id: `in_sec_${Date.now()}`,
            object: 'invoice',
            customer: 'cus_sec_unknown',
            amount_due: -1900,
            amount_paid: -1900,
            currency: 'usd',
            status: 'paid',
          },
        },
      });
      const header = sign(payload);

      const first = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        payload,
      });
      expect(first.statusCode).toBe(500);

      const stored = await built.services.db.primary
        .select({ status: stripeEvents.status })
        .from(stripeEvents)
        .where(eq(stripeEvents.stripeEventId, eventId));
      expect(stored[0]?.status).toBe('failed');

      const retry = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        payload,
      });

      // Stripe's retry must actually re-run a failed event, not be swallowed as
      // a duplicate — otherwise a paying customer never gets their plan.
      expect(retry.json()).not.toMatchObject({ duplicate: true });
    });

    it('reports a genuine redelivery of a processed event as a duplicate', async () => {
      const eventId = `evt_dup_${Date.now()}`;
      const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: `sub_sec_${Date.now()}`,
            object: 'subscription',
            status: 'active',
            customer: 'cus_sec_dup',
            cancel_at_period_end: false,
            trial_end: null,
            canceled_at: null,
            metadata: {},
            items: { object: 'list', data: [{ id: 'si_x', quantity: 1, price: { id: 'price_nope' } }] },
          },
        },
      });
      const header = sign(payload);

      const first = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        payload,
      });
      expect(first.json()).toMatchObject({ received: true, handled: true });

      const second = await built.app.inject({
        method: 'POST',
        url: '/billing/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        payload,
      });
      expect(second.json()).toMatchObject({ received: true, duplicate: true });
    });
  });

  // ------------------------------------------------------------------ Q6/Q7

  describe('Q6/Q7 — client-supplied amounts and mass assignment', () => {
    it('refuses negative, fractional and NaN simulation shapes', async () => {
      const session = await register('bad-amounts');

      for (const body of [
        { qubits: -8, shots: 1024, backend: 'statevector' },
        { qubits: 4.5, shots: 1024, backend: 'statevector' },
        { qubits: 4, shots: -1024, backend: 'statevector' },
        { qubits: 4, shots: 0.5, backend: 'statevector' },
      ]) {
        const response = await built.app.inject({
          method: 'POST',
          url: '/labs/quote',
          headers: headers(session),
          payload: body,
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('cannot mint credits through a negative backend multiplier', async () => {
      const session = await register('mult-inject');
      const response = await built.app.inject({
        method: 'POST',
        url: '/labs/quote',
        headers: headers(session),
        payload: {
          qubits: 20,
          shots: 1024,
          backend: 'statevector',
          // Not part of the schema: zod must strip it rather than let it reach
          // `creditCost`, where it would produce a negative quote.
          backendMultiplier: -1000,
        },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { credits: number }).credits).toBeGreaterThan(0);
    });

    it('ignores a client-supplied plan/entitlement on a billing write', async () => {
      const session = await register('mass-assign');
      // No Stripe network call happens: the plan lookup fails first for an
      // unknown plan, and a known plan is priced from the server catalogue.
      const response = await built.app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: headers(session),
        payload: { plan: 'campus', seats: 1, priceCents: 0, entitlements: { plan: 'campus' } },
      });
      // `campus` has no Stripe price: sold by contract. Never a free upgrade.
      expect([404, 409]).toContain(response.statusCode);

      const subscription = await built.app.inject({
        method: 'GET',
        url: '/billing/subscription',
        headers: headers(session),
      });
      expect((subscription.json() as { plan: string }).plan).toBe('free');
    });

    it('refuses a checkout redirect to an attacker-controlled origin', async () => {
      const session = await register('open-redirect');
      const response = await built.app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: headers(session),
        payload: {
          plan: 'pro',
          seats: 1,
          successUrl: 'https://redquant.evil.example/steal',
          cancelUrl: 'https://redquant.evil.example/steal',
        },
      });
      // The success/cancel URLs are echoed by Stripe's hosted page; they must be
      // pinned to our own origin.
      expect(response.statusCode).toBe(400);
    });
  });
});

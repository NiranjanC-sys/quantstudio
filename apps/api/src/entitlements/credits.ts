/**
 * Simulation credits (system-design §7).
 *
 *   One credit = one server-side simulation unit, priced as
 *   `ceil(2^(n-16)) * (shots/1024) * backend_multiplier`.
 *
 * A client-side (T-A) simulation costs nothing, which is why the browser engine
 * is a business decision as much as a latency one.
 *
 * The ledger is append-only with a materialised balance, and the debit happens
 * in the *same transaction* as the job enqueue, so a job can never run
 * uncharged.
 */
import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '../errors.js';
import { creditBalances, creditLedger } from '../db/schema/billing.js';
import type { Queryable } from '../db/client.js';

/** §4 tiers, priced by how much machine a backend actually costs to run. */
export const BACKEND_MULTIPLIERS = Object.freeze({
  /** T-B: dense statevector on the kernel. */
  statevector: 1,
  /** T-C: density-matrix / noisy simulation. Quadratically more state. */
  density_matrix: 4,
  /** T-C: tensor-network contraction. Cheaper than dense above ~34 qubits. */
  tensor_network: 2,
  /** T-C: stabilizer simulation is near-free but still occupies a worker. */
  stabilizer: 0.25,
  /** Real hardware time, brokered through a provider. */
  hardware: 25,
});

export type BackendKind = keyof typeof BACKEND_MULTIPLIERS;

export interface CreditQuote {
  qubits: number;
  shots: number;
  backend: BackendKind;
  backendMultiplier: number;
  /** The formula's exact value, before rounding. */
  rawCost: number;
  /** What is actually debited: integer, never below 1 for a real job. */
  credits: number;
}

export interface CreditCostInput {
  qubits: number;
  shots: number;
  backend: BackendKind;
  /** Overrides the table, for a provider-specific negotiated rate. */
  backendMultiplier?: number;
}

/**
 * `ceil(2^(n-16)) * (shots/1024) * backend_multiplier`.
 *
 * The `ceil` binds to `2^(n-16)` alone, as written in §7: below 16 qubits the
 * exponential term floors at 1, so a small circuit with many shots is still
 * priced by its shot count. The final debit is rounded up to a whole credit —
 * the ledger is integral — and never rounds a real job down to zero.
 */
export function creditCost(input: CreditCostInput): CreditQuote {
  const { qubits, shots, backend } = input;

  if (!Number.isInteger(qubits) || qubits < 1) {
    throw new ApiError('validation-failed', 'qubits must be a positive integer.');
  }
  if (!Number.isInteger(shots) || shots < 1) {
    throw new ApiError('validation-failed', 'shots must be a positive integer.');
  }

  const backendMultiplier = input.backendMultiplier ?? BACKEND_MULTIPLIERS[backend];
  const exponential = Math.ceil(Math.pow(2, qubits - 16));
  const rawCost = exponential * (shots / 1024) * backendMultiplier;

  return {
    qubits,
    shots,
    backend,
    backendMultiplier,
    rawCost,
    credits: Math.max(1, Math.ceil(rawCost)),
  };
}

export type CreditReason =
  | 'monthly_grant'
  | 'plan_change_grant'
  | 'promotional_grant'
  | 'simulation'
  | 'lab'
  | 'contest'
  | 'refund'
  | 'adjustment'
  | 'expiry';

export interface LedgerEntryInput {
  userId: string;
  orgId?: string | null;
  reason: CreditReason;
  refType?: string | null;
  refId?: string | null;
  /** Makes a retried enqueue a no-op instead of a second charge. */
  idempotencyKey?: string | null;
}

export interface LedgerResult {
  balance: number;
  /** `false` when an existing ledger row with the same key was found. */
  applied: boolean;
  ledgerId: number | null;
}

async function loadBalanceForUpdate(
  tx: Queryable,
  userId: string,
): Promise<{ balance: number; granted: number; consumed: number }> {
  const rows = await tx
    .select({
      balance: creditBalances.balance,
      granted: creditBalances.grantedThisPeriod,
      consumed: creditBalances.consumedThisPeriod,
    })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .for('update');

  const row = rows[0];
  if (!row) {
    throw new ApiError(
      'internal-error',
      'Credit balance row is missing for this user; it is created at signup.',
    );
  }
  return row;
}

async function findExistingEntry(
  tx: Queryable,
  userId: string,
  idempotencyKey: string,
): Promise<{ id: number; balanceAfter: number } | null> {
  const rows = await tx
    .select({ id: creditLedger.id, balanceAfter: creditLedger.balanceAfter })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.idempotencyKey, idempotencyKey)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Debits `credits` from a user, inside the caller's transaction.
 *
 * The row lock on `credit_balances` serialises concurrent debits for one user,
 * so the materialised balance and the append-only ledger cannot diverge. Call
 * this in the same transaction that writes the submission row and enqueues the
 * job — that is the whole point of the design.
 */
export async function debitCredits(
  tx: Queryable,
  input: LedgerEntryInput & { credits: number },
): Promise<LedgerResult> {
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    throw new ApiError('validation-failed', 'Credit debit must be a positive integer.');
  }

  if (input.idempotencyKey) {
    const existing = await findExistingEntry(tx, input.userId, input.idempotencyKey);
    if (existing) {
      return { balance: existing.balanceAfter, applied: false, ledgerId: existing.id };
    }
  }

  const current = await loadBalanceForUpdate(tx, input.userId);

  if (current.balance < input.credits) {
    throw new ApiError(
      'credits-exhausted',
      `This job costs ${input.credits} credits and your balance is ${current.balance}.`,
      { extensions: { required: input.credits, available: current.balance } },
    );
  }

  const balanceAfter = current.balance - input.credits;

  const inserted = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      orgId: input.orgId ?? null,
      delta: -input.credits,
      reason: input.reason,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      balanceAfter,
    })
    .returning({ id: creditLedger.id });

  await tx
    .update(creditBalances)
    .set({
      balance: balanceAfter,
      consumedThisPeriod: current.consumed + input.credits,
      updatedAt: new Date(),
    })
    .where(eq(creditBalances.userId, input.userId));

  return { balance: balanceAfter, applied: true, ledgerId: inserted[0]?.id ?? null };
}

/** Credits a user: the monthly grant, a plan change, or a refund of a failed job. */
export async function grantCredits(
  tx: Queryable,
  input: LedgerEntryInput & { credits: number },
): Promise<LedgerResult> {
  if (!Number.isInteger(input.credits) || input.credits <= 0) {
    throw new ApiError('validation-failed', 'Credit grant must be a positive integer.');
  }

  if (input.idempotencyKey) {
    const existing = await findExistingEntry(tx, input.userId, input.idempotencyKey);
    if (existing) {
      return { balance: existing.balanceAfter, applied: false, ledgerId: existing.id };
    }
  }

  const current = await loadBalanceForUpdate(tx, input.userId);
  const balanceAfter = current.balance + input.credits;

  const inserted = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      orgId: input.orgId ?? null,
      delta: input.credits,
      reason: input.reason,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      balanceAfter,
    })
    .returning({ id: creditLedger.id });

  const isGrant = input.reason.endsWith('_grant');

  await tx
    .update(creditBalances)
    .set({
      balance: balanceAfter,
      grantedThisPeriod: isGrant ? current.granted + input.credits : current.granted,
      consumedThisPeriod: isGrant
        ? current.consumed
        : Math.max(0, current.consumed - input.credits),
      updatedAt: new Date(),
    })
    .where(eq(creditBalances.userId, input.userId));

  return { balance: balanceAfter, applied: true, ledgerId: inserted[0]?.id ?? null };
}

export async function currentBalance(db: Queryable, userId: string): Promise<number> {
  const rows = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1);
  return rows[0]?.balance ?? 0;
}

/**
 * Sums the ledger from the beginning of time. The materialised balance must
 * equal this; the nightly reconciliation job asserts it, which is what makes the
 * append-only ledger worth having.
 */
export async function replayLedgerBalance(db: Queryable, userId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId));
  return rows[0]?.total ?? 0;
}

/**
 * Starts a new billing period: resets the counters and grants the plan's monthly
 * allowance. Unused credits do not roll over — §7 prices a monthly allowance,
 * not a stored balance.
 */
export async function startCreditPeriod(
  tx: Queryable,
  input: { userId: string; credits: number; periodStart: Date; periodEnd: Date; idempotencyKey: string },
): Promise<LedgerResult> {
  const existing = await findExistingEntry(tx, input.userId, input.idempotencyKey);
  if (existing) {
    return { balance: existing.balanceAfter, applied: false, ledgerId: existing.id };
  }

  await loadBalanceForUpdate(tx, input.userId);

  const inserted = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      delta: input.credits,
      reason: 'monthly_grant',
      refType: 'period',
      refId: input.periodStart.toISOString(),
      idempotencyKey: input.idempotencyKey,
      balanceAfter: input.credits,
    })
    .returning({ id: creditLedger.id });

  await tx
    .update(creditBalances)
    .set({
      balance: input.credits,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      grantedThisPeriod: input.credits,
      consumedThisPeriod: 0,
      updatedAt: new Date(),
    })
    .where(eq(creditBalances.userId, input.userId));

  return { balance: input.credits, applied: true, ledgerId: inserted[0]?.id ?? null };
}

/**
 * Client for billing.
 *
 * The browser never touches a card. It asks the gateway for a Stripe Checkout
 * session or a Customer Portal session and follows the URL the gateway returns;
 * everything that decides a plan happens in the webhook, on the server. This
 * file therefore has exactly two mutating calls and neither of them carries a
 * payment detail.
 *
 * Shapes were read off live responses. Two of them are easy to get wrong:
 *
 *   GET /billing/credits    -> { balance, monthlyGrant, items, limit, offset, total }
 *                              `monthlyGrant` is null on plans with no fixed
 *                              grant (campus negotiates one), which is not the
 *                              same as a grant of zero.
 *   GET /billing/subscription -> { subscription: <row or null>, entitlements, plan }
 *                              `subscription` is null for anyone who has never
 *                              paid, including users the entitlement table has
 *                              already put on a plan.
 *
 * The transport is shared with lib/instructor.ts. It lives there rather than in
 * lib/api.ts because that module is shared surface this change does not own,
 * and one problem-document classifier is worth more than two that can drift.
 */

import { API_URL } from './api';
import { classifyProblem, csrfHeader, type Remote } from './instructor';

export type { Failure, Remote } from './instructor';

interface ProblemBody {
  code?: string;
  detail?: string;
  title?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<Remote<T>> {
  const method = init?.method ?? 'GET';
  try {
    const res = await fetch(`${API_URL}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        accept: 'application/json',
        ...(method === 'GET' ? {} : { 'content-type': 'application/json', ...csrfHeader() }),
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ProblemBody | null;
      const code = body?.code ?? '';
      return {
        ok: false,
        kind: classifyProblem(res.status, code),
        status: res.status,
        code,
        detail: body?.detail ?? body?.title ?? `The gateway returned ${res.status}.`,
        fields: [],
      };
    }

    return { ok: true, data: (await res.json()) as T };
  } catch {
    return {
      ok: false,
      kind: 'unreachable',
      status: 0,
      code: 'unreachable',
      detail: 'Could not reach the gateway.',
      fields: [],
    };
  }
}

// ------------------------------------------------------------------ shapes

export type PlanCode = 'free' | 'pro' | 'teams' | 'campus';

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'paused';

/** A row of `GET /billing/plans`, which is the priced catalogue, not the matrix. */
export interface PlanRow {
  code: PlanCode;
  name: string;
  priceCents: number;
  currency: string;
  interval: string;
  seatBased: boolean;
  features: Record<string, unknown>;
  position: number;
}

export interface Subscription {
  id: string;
  planCode: PlanCode;
  status: SubscriptionStatus;
  seats: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
}

/** The snapshot the product actually enforces; Stripe is not consulted to read it. */
export interface Entitlements {
  plan: PlanCode;
  maxQubits: number;
  noisyMaxQubits: number | null;
  labsPerMonth: number | null;
  simCreditsPerMonth: number | null;
  tutorMessagesPerDay: number | null;
  instructorDashboard: boolean;
  certificates: boolean | string;
  interviewQuestions: number | null;
  [extension: string]: unknown;
}

export interface SubscriptionResponse {
  subscription: Subscription | null;
  entitlements: Entitlements;
  plan: PlanCode;
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

export interface CreditEntry {
  id: number;
  delta: number;
  reason: CreditReason;
  refType: string | null;
  refId: string | null;
  balanceAfter: number;
  createdAt: string;
}

export interface CreditsResponse {
  balance: number;
  /** Null when the plan has no fixed monthly grant, which is not zero. */
  monthlyGrant: number | null;
  items: CreditEntry[];
  limit: number;
  offset: number;
  total: number;
}

export interface Invoice {
  id: string;
  stripeInvoiceId: string;
  subscriptionId: string | null;
  userId: string | null;
  orgId: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  hostedInvoiceUrl: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
}

export interface InvoicesResponse {
  items: Invoice[];
  limit: number;
  offset: number;
  total: number;
}

// ------------------------------------------------------------------- calls

export function getPlans(): Promise<Remote<{ items: PlanRow[] }>> {
  return request('/billing/plans');
}

export function getSubscription(): Promise<Remote<SubscriptionResponse>> {
  return request('/billing/subscription');
}

export function getCredits(limit = 25, offset = 0): Promise<Remote<CreditsResponse>> {
  return request(`/billing/credits?limit=${limit}&offset=${offset}`);
}

export function getInvoices(limit = 12): Promise<Remote<InvoicesResponse>> {
  return request(`/billing/invoices?limit=${limit}`);
}

/**
 * Starts Stripe Checkout. The gateway creates the session and returns its URL;
 * the browser's only job is to go there.
 *
 * `successUrl` and `cancelUrl` are deliberately not sent. The gateway pins any
 * return URL it is given to the origin of its own `WEB_PUBLIC_URL` and rejects
 * anything else with a 400, precisely so a payment flow cannot be turned into
 * an open redirect. Its defaults already land on /billing/success and
 * /billing/cancelled, which this app serves, so the safe thing and the correct
 * thing are the same thing: send neither.
 */
export function startCheckout(
  plan: Exclude<PlanCode, 'free'>,
  seats: number,
): Promise<Remote<{ id: string; url: string | null }>> {
  return request('/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan, seats }),
  });
}

/** Opens the Stripe Customer Portal. 409 here means "no billing account yet". */
export function openPortal(): Promise<Remote<{ url: string }>> {
  return request('/billing/portal', { method: 'POST', body: JSON.stringify({}) });
}

// ----------------------------------------------------------------- helpers

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatCredits(value: number): string {
  return value.toLocaleString('en');
}

export function formatDay(iso: string | null): string {
  if (!iso) return 'Not set';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment overdue',
  canceled: 'Cancelled',
  incomplete: 'Incomplete',
  paused: 'Paused',
};

/**
 * A failed payment does not downgrade anyone immediately: the gateway keeps
 * `past_due` working through a grace window. Saying so is the difference
 * between a warning a reader can act on and one that reads as a lockout.
 */
export const STATUS_NOTE: Record<SubscriptionStatus, string> = {
  active: 'Renews automatically at the end of the period.',
  trialing: 'Your trial converts to a paid period unless you cancel first.',
  past_due: 'The last payment failed. Access continues during the grace window; update your card to keep it.',
  canceled: 'Access ends when the current period does.',
  incomplete: 'Checkout was started but never confirmed. Start it again to finish.',
  paused: 'Billing is paused. No charge is taken and paid features are off.',
};

export const CREDIT_REASON_LABEL: Record<CreditReason, string> = {
  monthly_grant: 'Monthly grant',
  plan_change_grant: 'Plan change grant',
  promotional_grant: 'Promotional grant',
  simulation: 'Simulation',
  lab: 'Lab run',
  contest: 'Contest run',
  refund: 'Refund',
  adjustment: 'Adjustment',
  expiry: 'Expired',
};

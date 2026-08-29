/**
 * Client for server-side simulation, tiers B and C of the design.
 *
 * The browser engine (`@redquant/qir`) handles up to 14 qubits with no network
 * round trip, which covers most editing. Anything larger, anything needing a
 * density matrix, and anything the learner wants to run on a specific SDK goes
 * to the server.
 *
 * It goes through the **gateway**, not straight to the kernel. The kernel is
 * deliberately ignorant of auth and billing, and the NetworkPolicy in
 * infra/k8s admits it no traffic except from the gateway, so plan resolution,
 * the qubit ceiling, the credit debit and the rate limit all live on the
 * gateway side. Calling the kernel directly works on a laptop and fails in
 * production, which is the worst kind of shortcut.
 *
 * Payload size is the gateway's problem too: above 16 qubits it asks the
 * kernel for the top-k probabilities rather than the full 2^n vector. A
 * 20 qubit result is 12.6 MB dense and 1.7 KB sparse, and no interface can
 * display a million bars regardless.
 */

import type { Circuit } from '@redquant/qir';
import { API_URL } from './api';

export type KernelBackend = 'native' | 'aer' | 'cirq' | 'pennylane' | 'density';

export interface KernelBackendInfo {
  name: string;
  available: boolean;
  methods: string[];
  maxQubits: number;
  supportsNoise: boolean;
  supportsMidCircuitMeasurement: boolean;
  detail: string | null;
  version: string;
}

export interface KernelResult {
  backend: string;
  method: string;
  qubits: number;
  clbits: number;
  statevector: number[] | null;
  probabilities: number[] | null;
  probabilitiesTopK?: [number, number][];
  probabilitiesResidual?: number;
  probabilitiesTruncated?: boolean;
  counts: Record<string, number> | null;
  bloch: { x: number; y: number; z: number; purity: number }[];
  stochastic: boolean;
  trajectories: number;
  shots: number;
  warnings: string[];
  timings: Record<string, number>;
}

export interface KernelResponse {
  result: KernelResult;
  metrics: Record<string, number | boolean>;
  circuitHash: string;
  cached: boolean;
  warnings: string[];
}

export type KernelOutcome =
  | { ok: true; data: KernelResponse }
  | { ok: false; kind: 'plan' | 'network' | 'server' | 'auth'; detail: string };

/**
 * The gateway pairs a session cookie with a CSRF token cookie that must be
 * echoed in a header. Reading it here keeps the double-submit intact.
 */
function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const m = document.cookie.match(/(?:^|;\s*)rq_csrf=([^;]+)/);
  return m?.[1] ? { 'x-csrf-token': decodeURIComponent(m[1]) } : {};
}

export interface RunOptions {
  backend: KernelBackend;
  shots: number;
  seed: number;
  bindings?: Record<string, number>;
  noise?: { depolarising1?: number; depolarising2?: number; readout?: number };
  /** Sent as a header; the kernel enforces size, the gateway decides the tier. */
  plan?: 'free' | 'pro' | 'teams' | 'campus';
  signal?: AbortSignal;
}

export async function listBackends(): Promise<KernelBackendInfo[]> {
  try {
    const res = await fetch(`${API_URL}/simulate/backends`, {
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { backends: KernelBackendInfo[] };
    return body.backends ?? [];
  } catch {
    return [];
  }
}

export async function simulateOnServer(
  circuit: Circuit,
  opts: RunOptions,
): Promise<KernelOutcome> {
  // The gateway decides sizes, sparsity and cost from the caller's plan, so
  // the client sends intent and nothing else.
  const body = {
    circuit,
    backend: opts.backend,
    shots: opts.shots,
    seed: opts.seed,
    bindings: opts.bindings ?? {},
    ...(opts.noise ? { noise: opts.noise } : {}),
  };

  try {
    const res = await fetch(`${API_URL}/simulate`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...csrfHeader(),
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (res.status === 401) {
      return { ok: false, kind: 'auth', detail: 'Sign in to run circuits on the server.' };
    }
    if (res.status === 402 || res.status === 403) {
      const b = (await res.json().catch(() => null)) as { detail?: string; message?: string } | null;
      return {
        ok: false,
        kind: 'plan',
        detail: b?.detail ?? b?.message ?? 'Your plan does not allow a circuit this large.',
      };
    }
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as { message?: string; detail?: string } | null;
      return { ok: false, kind: 'server', detail: b?.detail ?? b?.message ?? `Server returned ${res.status}.` };
    }
    return { ok: true, data: (await res.json()) as KernelResponse };
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return { ok: false, kind: 'network', detail: 'Run cancelled.' };
    }
    return { ok: false, kind: 'network', detail: 'Could not reach the server.' };
  }
}

/** Rows for the amplitude table, from either the dense or the sparse form. */
export function probabilityRows(
  r: KernelResult,
  limit = 64,
): { index: number; p: number; re: number | null; im: number | null }[] {
  const amp = (i: number) =>
    r.statevector ? { re: r.statevector[2 * i] ?? 0, im: r.statevector[2 * i + 1] ?? 0 } : { re: null, im: null };

  if (r.probabilitiesTopK?.length) {
    return r.probabilitiesTopK
      .slice(0, limit)
      .map(([index, p]) => ({ index, p, ...amp(index) }));
  }
  if (!r.probabilities) return [];
  return r.probabilities
    .map((p, index) => ({ index, p }))
    .filter((x) => x.p > 1e-12)
    .sort((a, b) => b.p - a.p)
    .slice(0, limit)
    .map((x) => ({ ...x, ...amp(x.index) }));
}

export interface SimulateEnvelope extends KernelResponse {
  /** Credits the gateway charged for this run. */
  credits?: number;
}

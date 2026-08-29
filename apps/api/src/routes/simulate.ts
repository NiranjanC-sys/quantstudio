/**
 * Synchronous simulation proxy.
 *
 * Tier B of the simulation design (§4). The browser owns up to 14 qubits with
 * no round trip; anything larger, anything needing a density matrix, and any
 * request for a specific SDK arrives here.
 *
 * The browser must not call the kernel directly. §3 makes the kernel ignorant
 * of auth and billing, and the NetworkPolicy in infra/k8s only admits traffic
 * from this gateway, so plan resolution, the qubit ceiling, the credit debit
 * and the rate limit all belong on this side of the boundary. The kernel is
 * told the tier through a header and enforces size alone.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { creditCost, debitCredits, grantCredits } from '../entitlements/credits.js';
import { ApiError } from '../errors.js';
import { randomUUID } from '../lib/crypto.js';
import { createDegradationController, effectiveQubitCap } from '../lib/degradation.js';
import { authed, rateLimit, readBody } from './helpers.js';

const opSchema = z.object({
  id: z.string().min(1).max(64),
  gate: z.string().min(1).max(32),
  targets: z.array(z.number().int().min(0).max(63)).min(1).max(8),
  controls: z.array(z.number().int().min(0).max(63)).max(16).optional(),
  params: z.array(z.union([z.number(), z.object({ symbol: z.string().min(1).max(32) })])).max(8).optional(),
  cbits: z.array(z.number().int().min(0).max(63)).max(8).optional(),
  condition: z.object({ bits: z.array(z.number().int().min(0)).max(32), value: z.number().int().min(0) }).optional(),
});

const circuitSchema = z.object({
  version: z.literal(1),
  name: z.string().max(120).default('circuit'),
  qubits: z.number().int().min(1).max(40),
  clbits: z.number().int().min(0).max(64),
  ops: z.array(opSchema).max(4096),
});

const bodySchema = z.object({
  circuit: circuitSchema,
  backend: z.enum(['native', 'aer', 'cirq', 'pennylane', 'density']).default('native'),
  shots: z.number().int().min(0).max(100_000).default(1024),
  seed: z.number().int().min(0).max(2 ** 31).optional(),
  bindings: z.record(z.string(), z.number()).default({}),
  noise: z
    .object({
      depolarising1: z.number().min(0).max(1).optional(),
      depolarising2: z.number().min(0).max(1).optional(),
      readout: z.number().min(0).max(1).optional(),
    })
    .optional(),
  includeVisual: z.boolean().default(false),
});

/**
 * Above this many qubits the dense probability vector is not worth shipping: a
 * 20 qubit result is 12.6 MB dense and 1.7 KB as the top 64, and no interface
 * can render a million bars. The kernel returns the sparse form instead.
 */
const SPARSE_ABOVE = 16;
const STATEVECTOR_ABOVE = 18;
const TOP_K = 64;

export const simulateRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis, env } = app.services;
  const degradation = createDegradationController(env, redis.client);

  // The 'simulation' class is plan-aware by design (§9: 30/min free,
  // 240/min Pro), so the limiter reads the tier rather than this route
  // hardcoding a number.
  const limit = rateLimit(app, 'simulation');

  app.post('/', { preHandler: [limit] }, async (request, reply) => {
    const auth = authed(request);
    const input = readBody(request, bodySchema);
    const entitlements = request.entitlements ?? auth.entitlements;
    const state = await degradation.get();

    const noisy = input.backend === 'density' || Boolean(input.noise);
    const planCap = noisy ? entitlements.noisyMaxQubits : entitlements.maxQubits;

    if (planCap === null) {
      throw new ApiError(
        'entitlement-required',
        'Noisy simulation is not included in your plan.',
        { extensions: { feature: 'simulation.noisy', requiredPlan: 'pro' } },
      );
    }

    // §9 step 2: an operator can temporarily lower the ceiling under load, and
    // the response says so rather than silently shrinking the circuit.
    const cap = effectiveQubitCap(planCap, state);
    if (input.circuit.qubits > cap) {
      throw new ApiError(
        'entitlement-required',
        `This circuit needs ${input.circuit.qubits} qubits; the current ceiling is ${cap}.`,
        {
          extensions: {
            feature: 'simulation.qubits',
            requested: input.circuit.qubits,
            planCap,
            effectiveCap: cap,
            notice: state.notice,
          },
        },
      );
    }

    // The credit table is keyed by simulation *method*, not by SDK: Aer, Cirq
    // and PennyLane all do dense statevector work and cost the same.
    const method = input.backend === 'density' ? 'density_matrix' : 'statevector';

    const quote = creditCost({
      qubits: input.circuit.qubits,
      shots: Math.max(1, input.shots),
      backend: method,
    });

    // Debit before running. A job that runs uncharged is a billing hole; a
    // charge for a job that then fails is refunded by the catch below.
    const debitKey = randomUUID();
    await debitCredits(db.primary, {
      userId: auth.userId,
      credits: quote.credits,
      reason: 'simulation',
      idempotencyKey: debitKey,
    });

    const n = input.circuit.qubits;
    const payload = {
      circuit: input.circuit,
      backend: input.backend,
      include_visual: input.includeVisual,
      options: {
        shots: input.shots,
        seed: input.seed ?? null,
        bindings: input.bindings,
        ...(input.noise ? { noise: input.noise } : {}),
        method,
        max_qubits: cap,
        return_statevector: n <= STATEVECTOR_ABOVE,
        ...(n > SPARSE_ABOVE ? { probability_top_k: TOP_K } : {}),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.QUANTUM_KERNEL_TIMEOUT_MS * 4);

    try {
      const res = await fetch(`${env.QUANTUM_KERNEL_URL}/v1/simulate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-RedQuant-Plan': entitlements.plan,
          'X-Request-Id': request.id,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { message?: string } | null;
        // The kernel refused, so the learner got nothing. Give the credits back.
        await grantCredits(db.primary, {
          userId: auth.userId,
          credits: quote.credits,
          reason: 'refund',
          idempotencyKey: `${debitKey}:refund`,
        }).catch(() => undefined);
        throw new ApiError(
          res.status === 402 ? 'entitlement-required' : 'upstream-unavailable',
          detail?.message ?? `The simulation kernel returned ${res.status}.`,
        );
      }

      const body = (await res.json()) as Record<string, unknown>;
      return reply.header('cache-control', 'no-store').send({ ...body, credits: quote.credits });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      await grantCredits(db.primary, {
        userId: auth.userId,
        credits: quote.credits,
        reason: 'refund',
        idempotencyKey: `${debitKey}:refund`,
      }).catch(() => undefined);
      throw new ApiError('upstream-unavailable', 'The simulation kernel is unavailable.');
    } finally {
      clearTimeout(timer);
    }
  });

  /** What the kernel can currently do, for the backend picker. */
  app.get('/backends', async (_request, reply) => {
    try {
      const res = await fetch(`${env.QUANTUM_KERNEL_URL}/v1/backends`);
      if (!res.ok) return reply.send({ backends: [] });
      return reply.header('cache-control', 'public, max-age=60').send(await res.json());
    } catch {
      return reply.send({ backends: [] });
    }
  });
};

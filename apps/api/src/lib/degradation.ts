/**
 * The graceful-degradation ladder from system-design §9, as runtime state.
 *
 * Steps 1 and 2 ("kernel saturated → queue instead of answering synchronously",
 * "still saturated → cap server sims at 22 qubits") and step 3 ("AI tutor over
 * budget → retrieval-only") have to be flippable without a deploy, so the
 * operator-set values live in Redis and the environment supplies the defaults.
 * A Redis outage falls back to the environment rather than to "everything on",
 * which is the safe direction.
 */
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { Env } from '../env.js';

const KEY = 'ops:degradation';

export const degradationSchema = z.object({
  /** §9 step 1: T-B simulations return 202 + queue position. */
  simQueueOnly: z.boolean(),
  /** §9 step 2: temporary server-side qubit cap, below the plan's own limit. */
  maxQubits: z.number().int().min(1).max(64).nullable(),
  /** §9 step 3: tutor answers from retrieval only, labelled as such. */
  tutorRetrievalOnly: z.boolean(),
  /** §9 step 6: writes rejected with Retry-After during a primary failover. */
  writesDisabled: z.boolean(),
  /** Free-text note surfaced to clients so the UI can state the cap honestly. */
  notice: z.string().max(280).nullable(),
});

export type DegradationState = z.infer<typeof degradationSchema>;

export function defaultDegradation(env: Env): DegradationState {
  return {
    simQueueOnly: env.DEGRADE_SIM_QUEUE_ONLY,
    maxQubits: env.DEGRADE_MAX_QUBITS ?? null,
    tutorRetrievalOnly: false,
    writesDisabled: false,
    notice: null,
  };
}

export interface DegradationController {
  get(): Promise<DegradationState>;
  set(patch: Partial<DegradationState>): Promise<DegradationState>;
  clear(): Promise<DegradationState>;
}

export function createDegradationController(
  env: Env,
  redis: Redis,
): DegradationController {
  const fallback = defaultDegradation(env);

  async function read(): Promise<DegradationState> {
    try {
      const raw = await redis.get(KEY);
      if (!raw) return { ...fallback };
      const parsed = degradationSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }

  return {
    get: read,
    async set(patch) {
      const next: DegradationState = { ...(await read()), ...patch };
      await redis.set(KEY, JSON.stringify(next));
      return next;
    },
    async clear() {
      await redis.del(KEY);
      return { ...fallback };
    },
  };
}

/**
 * The qubit ceiling that actually applies: the lower of the plan's entitlement
 * and any temporary operator cap.
 */
export function effectiveQubitCap(planCap: number, state: DegradationState): number {
  return state.maxQubits === null ? planCap : Math.min(planCap, state.maxQubits);
}

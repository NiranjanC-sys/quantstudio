/**
 * Bayesian knowledge tracing plus a forgetting curve, per the syllabus:
 *
 *   "Per concept node: mastery ∈ [0,1], updated by a Bayesian knowledge-tracing
 *    step on every graded interaction, decayed by a per-node forgetting curve
 *    whose half-life extends with each successful spaced review."
 */

export interface BktParameters {
  /** P(L0): prior probability the learner already knows the concept. */
  prior: number;
  /** P(T): probability of learning it from one interaction. */
  learn: number;
  /** P(S): probability of answering wrong despite knowing it. */
  slip: number;
  /** P(G): probability of answering right without knowing it. */
  guess: number;
}

export const DEFAULT_BKT: BktParameters = {
  prior: 0.1,
  learn: 0.25,
  slip: 0.1,
  guess: 0.2,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * One BKT update. Returns the posterior probability of mastery after observing
 * `correct`, including the learning-transition step.
 */
export function bktUpdate(
  current: number,
  correct: boolean,
  params: BktParameters = DEFAULT_BKT,
): number {
  const p = clamp01(current);
  const { learn, slip, guess } = params;

  const posterior = correct
    ? (p * (1 - slip)) / (p * (1 - slip) + (1 - p) * guess)
    : (p * slip) / (p * slip + (1 - p) * (1 - guess));

  // Degenerate parameters (guess = 0 and p = 0, say) make the denominator zero.
  const safePosterior = Number.isFinite(posterior) ? posterior : p;

  return clamp01(safePosterior + (1 - safePosterior) * learn);
}

/**
 * A partially-correct observation — a lab that passed 7 of 10 hidden tests —
 * is folded in as a weighted blend of the correct and incorrect updates rather
 * than being thresholded, which would throw away most of the signal.
 */
export function bktUpdateGraded(
  current: number,
  score: number,
  params: BktParameters = DEFAULT_BKT,
): number {
  const s = clamp01(score);
  return clamp01(s * bktUpdate(current, true, params) + (1 - s) * bktUpdate(current, false, params));
}

/**
 * Forgetting curve: retrievability halves every `halfLifeHours`, decaying
 * towards the prior rather than towards zero — a learner who has seen a concept
 * once never returns to a blank slate.
 */
export function decayMastery(
  mastery: number,
  hoursElapsed: number,
  halfLifeHours: number,
  prior = DEFAULT_BKT.prior,
): number {
  if (hoursElapsed <= 0) return clamp01(mastery);
  if (halfLifeHours <= 0) return clamp01(prior);
  const retained = Math.pow(2, -hoursElapsed / halfLifeHours);
  return clamp01(prior + (clamp01(mastery) - prior) * retained);
}

/** Predicted probability of recall right now, given the last review. */
export function retrievability(hoursElapsed: number, halfLifeHours: number): number {
  if (halfLifeHours <= 0) return 0;
  return Math.pow(2, -Math.max(0, hoursElapsed) / halfLifeHours);
}

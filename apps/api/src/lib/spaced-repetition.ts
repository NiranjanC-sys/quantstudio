/**
 * The review scheduler behind `progress.review_queue`.
 *
 * The schedule is a forgetting curve, not a fixed ladder: an item is due when
 * its predicted retrievability `2^(-t/h)` falls to `targetRetention`, and the
 * half-life `h` extends on every successful review (syllabus, Mastery model).
 * The ease factor modulates how fast the half-life grows, in the spirit of SM-2
 * but applied to the half-life rather than to the interval directly.
 */
import { retrievability } from './mastery.js';

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

export interface ScheduleState {
  halfLifeHours: number;
  intervalHours: number;
  ease: number;
  repetitions: number;
  lapses: number;
}

export interface ScheduleConfig {
  /** Recall probability at which an item becomes due. */
  targetRetention: number;
  initialHalfLifeHours: number;
  initialEase: number;
  minEase: number;
  maxEase: number;
  maxIntervalHours: number;
  /** Half-life multiplier applied when an item is forgotten. */
  lapsePenalty: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  targetRetention: 0.9,
  initialHalfLifeHours: 72,
  initialEase: 2.5,
  minEase: 1.3,
  maxEase: 3.5,
  maxIntervalHours: 365 * 24,
  lapsePenalty: 0.4,
};

export function initialState(config: ScheduleConfig = DEFAULT_SCHEDULE): ScheduleState {
  return {
    halfLifeHours: config.initialHalfLifeHours,
    intervalHours: intervalForHalfLife(config.initialHalfLifeHours, config),
    ease: config.initialEase,
    repetitions: 0,
    lapses: 0,
  };
}

/** Solves `2^(-t/h) = targetRetention` for t. */
export function intervalForHalfLife(
  halfLifeHours: number,
  config: ScheduleConfig = DEFAULT_SCHEDULE,
): number {
  const interval = halfLifeHours * Math.log2(1 / config.targetRetention);
  return Math.min(config.maxIntervalHours, Math.max(0.25, interval));
}

const EASE_DELTA: Record<ReviewGrade, number> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.15,
};

/** How much the half-life grows for a given grade, as a factor of `ease`. */
const GROWTH: Record<ReviewGrade, number> = {
  again: 0,
  hard: 0.6,
  good: 1,
  easy: 1.3,
};

export interface ReviewOutcome {
  state: ScheduleState;
  dueAt: Date;
  /** Predicted recall at the moment of review — feeds the mastery decay. */
  retrievabilityAtReview: number;
}

/**
 * Applies one review. `hoursSinceLastReview` is used only to report the
 * retrievability actually observed; the next schedule depends on the grade.
 */
export function reviewItem(
  state: ScheduleState,
  grade: ReviewGrade,
  now: Date,
  hoursSinceLastReview: number,
  config: ScheduleConfig = DEFAULT_SCHEDULE,
): ReviewOutcome {
  const observed = retrievability(hoursSinceLastReview, state.halfLifeHours);
  const ease = Math.min(config.maxEase, Math.max(config.minEase, state.ease + EASE_DELTA[grade]));

  let halfLifeHours: number;
  let repetitions: number;
  let lapses = state.lapses;

  if (grade === 'again') {
    halfLifeHours = Math.max(1, state.halfLifeHours * config.lapsePenalty);
    repetitions = 0;
    lapses += 1;
  } else {
    halfLifeHours = state.halfLifeHours * (1 + (ease - 1) * GROWTH[grade]);
    repetitions = state.repetitions + 1;
  }

  const intervalHours = intervalForHalfLife(halfLifeHours, config);

  return {
    state: { halfLifeHours, intervalHours, ease, repetitions, lapses },
    dueAt: new Date(now.getTime() + intervalHours * 3_600_000),
    retrievabilityAtReview: observed,
  };
}

/**
 * Orders a due queue: least likely to be recalled first, so the session spends
 * its time where forgetting is actually happening.
 */
export function orderDueQueue<T extends { dueAt: Date; halfLifeHours: number }>(
  items: readonly T[],
  now: Date,
): T[] {
  return [...items].sort((a, b) => {
    const ra = retrievability((now.getTime() - a.dueAt.getTime()) / 3_600_000, a.halfLifeHours);
    const rb = retrievability((now.getTime() - b.dueAt.getTime()) / 3_600_000, b.halfLifeHours);
    if (ra !== rb) return ra - rb;
    return a.dueAt.getTime() - b.dueAt.getTime();
  });
}

/**
 * Glicko-2, as specified by Mark Glickman ("Example of the Glicko-2 system",
 * 2013). Used by the contest finaliser (system-design §6): 350 initial rating
 * deviation, and a per-contest volatility cap.
 *
 * The implementation is deliberately pure — no clock, no I/O — so the finaliser
 * can be replayed offline against the submission log.
 */

/** Ratings live on the Glicko-1 scale externally and the Glicko-2 scale internally. */
const SCALE = 173.7178;
const DEFAULT_RATING = 1500;

export interface Glicko2Config {
  /** System constant τ: how fast volatility is allowed to move. 0.3-1.2. */
  tau: number;
  /** Convergence tolerance for the volatility iteration. */
  epsilon: number;
  /** system-design §6: initial rating deviation. */
  initialRd: number;
  initialVolatility: number;
  /** Upper bound on σ′, the "per-contest volatility cap" of §6. */
  maxVolatility: number;
  /** Floor on RD, so an established player still moves. */
  minRd: number;
  /** Ceiling on RD, so an absent player never exceeds a provisional rating. */
  maxRd: number;
}

export const DEFAULT_CONFIG: Glicko2Config = {
  tau: 0.5,
  epsilon: 0.000001,
  initialRd: 350,
  initialVolatility: 0.06,
  maxVolatility: 0.1,
  minRd: 30,
  maxRd: 350,
};

export interface Rating {
  rating: number;
  rd: number;
  volatility: number;
}

/** One opponent and the score against them: 1 win, 0.5 draw, 0 loss. */
export interface MatchResult {
  opponent: Rating;
  score: number;
}

export function defaultRating(config: Glicko2Config = DEFAULT_CONFIG): Rating {
  return {
    rating: DEFAULT_RATING,
    rd: config.initialRd,
    volatility: config.initialVolatility,
  };
}

function toGlicko2(rating: Rating): { mu: number; phi: number; sigma: number } {
  return {
    mu: (rating.rating - DEFAULT_RATING) / SCALE,
    phi: rating.rd / SCALE,
    sigma: rating.volatility,
  };
}

function fromGlicko2(
  mu: number,
  phi: number,
  sigma: number,
  config: Glicko2Config,
): Rating {
  return {
    rating: SCALE * mu + DEFAULT_RATING,
    rd: clamp(SCALE * phi, config.minRd, config.maxRd),
    volatility: clamp(sigma, 0.000001, config.maxVolatility),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** g(φ): how much an opponent's uncertainty dampens the information they carry. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** E(μ, μj, φj): expected score against one opponent. */
function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Illinois-variant regula falsi for σ′ (Glickman step 5). The bracket is chosen
 * exactly as in the paper, including the `k`-doubling search used when
 * Δ² ≤ φ² + v.
 */
function solveVolatility(
  phi: number,
  sigma: number,
  v: number,
  delta: number,
  config: Glicko2Config,
): number {
  const a = Math.log(sigma * sigma);
  const tauSq = config.tau * config.tau;
  const phiSq = phi * phi;
  const deltaSq = delta * delta;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const numerator = ex * (deltaSq - phiSq - v - ex);
    const denominator = 2 * (phiSq + v + ex) * (phiSq + v + ex);
    return numerator / denominator - (x - a) / tauSq;
  };

  let A = a;
  let B: number;

  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * config.tau) < 0) {
      k += 1;
      // The paper's search always terminates; the guard is here so a pathological
      // input cannot spin a finaliser worker forever.
      if (k > 1000) break;
    }
    B = a - k * config.tau;
  }

  let fA = f(A);
  let fB = f(B);
  let iterations = 0;

  while (Math.abs(B - A) > config.epsilon && iterations < 1000) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);

    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }

    B = C;
    fB = fC;
    iterations += 1;
  }

  return Math.exp(A / 2);
}

/**
 * Rates one player against the set of opponents they were compared with in a
 * single rating period (one contest).
 *
 * With no results the rating is unchanged and only the deviation grows, which is
 * the correct behaviour for a player who sat the contest out.
 */
export function rate(
  player: Rating,
  results: readonly MatchResult[],
  config: Glicko2Config = DEFAULT_CONFIG,
): Rating {
  const { mu, phi, sigma } = toGlicko2(player);

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return fromGlicko2(mu, phiStar, sigma, config);
  }

  let vInverse = 0;
  let deltaSum = 0;

  for (const { opponent, score } of results) {
    const { mu: muJ, phi: phiJ } = toGlicko2(opponent);
    const gPhiJ = g(phiJ);
    const e = expectedScore(mu, muJ, phiJ);
    vInverse += gPhiJ * gPhiJ * e * (1 - e);
    deltaSum += gPhiJ * (score - e);
  }

  // A player who faced only opponents with identical ratings and drew every game
  // produces v→∞; guard the division rather than emitting NaN into the database.
  if (vInverse <= 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return fromGlicko2(mu, phiStar, sigma, config);
  }

  const v = 1 / vInverse;
  const delta = v * deltaSum;

  const sigmaPrime = clamp(
    solveVolatility(phi, sigma, v, delta, config),
    0.000001,
    config.maxVolatility,
  );

  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return fromGlicko2(muPrime, phiPrime, sigmaPrime, config);
}

export interface ContestParticipant<Id extends string = string> {
  id: Id;
  rating: Rating;
  /** Final standing, 1 = best. Ties share a rank. */
  rank: number;
}

/**
 * Rates a whole contest as one Glicko-2 rating period.
 *
 * Every participant is scored against every other: 1 for a better rank, 0.5 for
 * a tie, 0 for a worse one. That is the standard round-robin reduction used for
 * multiplayer events, and it keeps the finaliser a single batch job as §6
 * requires. Every player is rated against the *pre-contest* ratings of their
 * opponents, so the result does not depend on iteration order.
 */
export function rateContest<Id extends string = string>(
  participants: readonly ContestParticipant<Id>[],
  config: Glicko2Config = DEFAULT_CONFIG,
): Map<Id, Rating> {
  const before = participants.map((p) => ({ ...p, rating: { ...p.rating } }));
  const output = new Map<Id, Rating>();

  for (const player of before) {
    const results: MatchResult[] = [];
    for (const opponent of before) {
      if (opponent.id === player.id) continue;
      const score = player.rank < opponent.rank ? 1 : player.rank === opponent.rank ? 0.5 : 0;
      results.push({ opponent: opponent.rating, score });
    }
    output.set(player.id, rate(player.rating, results, config));
  }

  return output;
}

/**
 * Expected score of `a` against `b` on the Glicko-1 scale. Used by the UI to
 * show a predicted placement, never by the rating maths itself.
 */
export function winProbability(a: Rating, b: Rating): number {
  const { mu: muA } = toGlicko2(a);
  const { mu: muB, phi: phiB } = toGlicko2(b);
  return expectedScore(muA, muB, phiB);
}

/**
 * Glicko-2 (system-design §6: "350 initial deviation and a per-contest
 * volatility cap, computed in one batch job").
 *
 * The anchor is Glickman's own worked example from "Example of the Glicko-2
 * system" (2013): a player at 1500/200/0.06 with τ = 0.5 facing three opponents
 * ends at μ′ ≈ -0.2069, φ′ ≈ 0.8722, σ′ ≈ 0.05999. Converted back to the
 * Glicko-1 scale that is rating ≈ 1464.06, RD ≈ 151.52.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  defaultRating,
  rate,
  rateContest,
  winProbability,
  type Glicko2Config,
  type Rating,
} from '../../src/lib/glicko2.js';

const PAPER_CONFIG: Glicko2Config = { ...DEFAULT_CONFIG, tau: 0.5, minRd: 1, maxRd: 350 };

describe('rate — Glickman worked example', () => {
  const player: Rating = { rating: 1500, rd: 200, volatility: 0.06 };
  const opponents: Rating[] = [
    { rating: 1400, rd: 30, volatility: 0.06 },
    { rating: 1550, rd: 100, volatility: 0.06 },
    { rating: 1700, rd: 300, volatility: 0.06 },
  ];

  it('reproduces the published result', () => {
    const result = rate(
      player,
      [
        { opponent: opponents[0] as Rating, score: 1 },
        { opponent: opponents[1] as Rating, score: 0 },
        { opponent: opponents[2] as Rating, score: 0 },
      ],
      PAPER_CONFIG,
    );

    expect(result.rating).toBeCloseTo(1464.06, 1);
    expect(result.rd).toBeCloseTo(151.52, 1);
    expect(result.volatility).toBeCloseTo(0.05999, 4);
  });
});

describe('rate — behaviour', () => {
  it('leaves the rating alone and widens RD for a player who sat out', () => {
    const player: Rating = { rating: 1732, rd: 90, volatility: 0.06 };
    const result = rate(player, [], PAPER_CONFIG);

    expect(result.rating).toBeCloseTo(1732, 6);
    expect(result.rd).toBeGreaterThan(player.rd);
  });

  it('narrows RD as evidence accumulates', () => {
    const player = defaultRating();
    const opponent: Rating = { rating: 1500, rd: 50, volatility: 0.06 };

    let current = player;
    for (let round = 0; round < 5; round += 1) {
      current = rate(current, [{ opponent, score: 1 }], PAPER_CONFIG);
    }

    expect(current.rd).toBeLessThan(player.rd);
    expect(current.rating).toBeGreaterThan(player.rating);
  });

  it('moves a beaten favourite down and a winning underdog up', () => {
    const favourite: Rating = { rating: 1900, rd: 60, volatility: 0.06 };
    const underdog: Rating = { rating: 1400, rd: 60, volatility: 0.06 };

    const favouriteAfter = rate(favourite, [{ opponent: underdog, score: 0 }], PAPER_CONFIG);
    const underdogAfter = rate(underdog, [{ opponent: favourite, score: 1 }], PAPER_CONFIG);

    expect(favouriteAfter.rating).toBeLessThan(favourite.rating);
    expect(underdogAfter.rating).toBeGreaterThan(underdog.rating);
    // An upset moves both a long way, because both were confident. With RD 60
    // on each side, a single 500-point upset is worth ~20 rating points.
    expect(favourite.rating - favouriteAfter.rating).toBeGreaterThan(15);
    expect(underdogAfter.rating - underdog.rating).toBeGreaterThan(15);
  });

  it('honours the §6 per-contest volatility cap', () => {
    const capped: Glicko2Config = { ...PAPER_CONFIG, tau: 1.2, maxVolatility: 0.061 };
    const volatile_: Rating = { rating: 1500, rd: 350, volatility: 0.06 };
    const crusher: Rating = { rating: 2600, rd: 30, volatility: 0.06 };

    const result = rate(volatile_, [{ opponent: crusher, score: 1 }], capped);
    expect(result.volatility).toBeLessThanOrEqual(0.061);
  });

  it('clamps RD into the configured band', () => {
    const settled: Rating = { rating: 1500, rd: 30, volatility: 0.06 };
    const opponent: Rating = { rating: 1500, rd: 30, volatility: 0.06 };

    let current = settled;
    for (let round = 0; round < 50; round += 1) {
      current = rate(current, [{ opponent, score: 0.5 }], DEFAULT_CONFIG);
    }

    expect(current.rd).toBeGreaterThanOrEqual(DEFAULT_CONFIG.minRd);
    expect(current.rd).toBeLessThanOrEqual(DEFAULT_CONFIG.maxRd);
    expect(Number.isFinite(current.rating)).toBe(true);
  });

  it('starts a new player at 1500 with the §6 initial deviation of 350', () => {
    const fresh = defaultRating();
    expect(fresh.rating).toBe(1500);
    expect(fresh.rd).toBe(350);
    expect(fresh.volatility).toBe(0.06);
  });
});

describe('rateContest', () => {
  it('rates everyone against the pre-contest ratings, so order does not matter', () => {
    const participants = [
      { id: 'a', rank: 1, rating: { rating: 1500, rd: 200, volatility: 0.06 } },
      { id: 'b', rank: 2, rating: { rating: 1600, rd: 120, volatility: 0.06 } },
      { id: 'c', rank: 3, rating: { rating: 1400, rd: 300, volatility: 0.06 } },
      { id: 'd', rank: 4, rating: { rating: 1700, rd: 80, volatility: 0.06 } },
    ];

    const forwards = rateContest(participants, PAPER_CONFIG);
    const backwards = rateContest([...participants].reverse(), PAPER_CONFIG);

    for (const id of ['a', 'b', 'c', 'd']) {
      expect(forwards.get(id)?.rating).toBeCloseTo(backwards.get(id)?.rating ?? NaN, 10);
      expect(forwards.get(id)?.rd).toBeCloseTo(backwards.get(id)?.rd ?? NaN, 10);
    }
  });

  it('orders rating change by finishing position', () => {
    const participants = Array.from({ length: 8 }, (_, index) => ({
      id: `p${index}`,
      rank: index + 1,
      rating: { rating: 1500, rd: 200, volatility: 0.06 },
    }));

    const rated = rateContest(participants, PAPER_CONFIG);
    const ratings = participants.map((p) => rated.get(p.id)?.rating ?? NaN);

    // Equal starting ratings, so the final order must be exactly the standings.
    for (let i = 1; i < ratings.length; i += 1) {
      expect(ratings[i - 1] as number).toBeGreaterThan(ratings[i] as number);
    }
    // The winner gains and the last place loses.
    expect(ratings[0] as number).toBeGreaterThan(1500);
    expect(ratings[ratings.length - 1] as number).toBeLessThan(1500);
  });

  it('treats a tie as half a point in both directions', () => {
    const rated = rateContest(
      [
        { id: 'x', rank: 1, rating: { rating: 1500, rd: 200, volatility: 0.06 } },
        { id: 'y', rank: 1, rating: { rating: 1500, rd: 200, volatility: 0.06 } },
      ],
      PAPER_CONFIG,
    );

    expect(rated.get('x')?.rating).toBeCloseTo(1500, 6);
    expect(rated.get('y')?.rating).toBeCloseTo(1500, 6);
    // A drawn game is still information: RD must shrink.
    expect(rated.get('x')?.rd).toBeLessThan(200);
  });

  it('is a no-op for a single participant', () => {
    const rated = rateContest(
      [{ id: 'solo', rank: 1, rating: { rating: 1811, rd: 70, volatility: 0.06 } }],
      PAPER_CONFIG,
    );
    expect(rated.get('solo')?.rating).toBeCloseTo(1811, 6);
    expect(rated.get('solo')?.rd).toBeGreaterThan(70);
  });

  it('never produces NaN, even for a large field of identical players', () => {
    const participants = Array.from({ length: 200 }, (_, index) => ({
      id: `p${index}`,
      rank: 1,
      rating: { rating: 1500, rd: 350, volatility: 0.06 },
    }));

    const rated = rateContest(participants, DEFAULT_CONFIG);
    for (const [, rating] of rated) {
      expect(Number.isFinite(rating.rating)).toBe(true);
      expect(Number.isFinite(rating.rd)).toBe(true);
      expect(Number.isFinite(rating.volatility)).toBe(true);
    }
  });
});

describe('winProbability', () => {
  it('is symmetric around 0.5 for equal ratings and monotone in the gap', () => {
    const even: Rating = { rating: 1500, rd: 50, volatility: 0.06 };
    expect(winProbability(even, even)).toBeCloseTo(0.5, 6);

    const stronger: Rating = { rating: 1800, rd: 50, volatility: 0.06 };
    expect(winProbability(stronger, even)).toBeGreaterThan(0.5);
    expect(winProbability(even, stronger)).toBeLessThan(0.5);
    expect(winProbability(stronger, even) + winProbability(even, stronger)).toBeCloseTo(1, 6);
  });
});

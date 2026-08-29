/**
 * Freeze and finalisation (system-design §6).
 *
 *   "At T-60min the public board freezes (broadcaster stops publishing; the
 *    Redis ZSET keeps updating). At T+0 a finaliser job snapshots the ZSET into
 *    `contest.standings_snapshots`, recomputes ratings, and publishes the final
 *    board. Ratings use Glicko-2 with a 350 initial deviation and a per-contest
 *    volatility cap, computed in one batch job."
 *
 * Both operations are idempotent: the snapshot table has a unique index on
 * `(contest_id, kind)` and `rating_history` on `(user_id, contest_id)`, so a
 * retried job converges instead of double-rating anyone.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseHandles } from '../db/client.js';
import {
  contests,
  ratingHistory,
  ratings as ratingsTable,
  registrations,
  standingsRows,
  standingsSnapshots,
  submissions as contestSubmissions,
} from '../db/schema/contest.js';
import { ApiError } from '../errors.js';
import { DEFAULT_CONFIG, rateContest, type ContestParticipant, type Rating } from '../lib/glicko2.js';
import { keys } from '../redis/scripts.js';
import {
  readWholeBoard,
  type ContestWindow,
  type ScoringDeps,
  type StandingsEntry,
} from './scoring.js';

export interface ContestRow extends ContestWindow {
  slug: string;
  kind: 'rated' | 'unrated' | 'private';
  status: string;
}

export interface SnapshotResult {
  snapshotId: string;
  kind: 'freeze' | 'final';
  participantCount: number;
  /** False when an identical snapshot already existed (retried job). */
  created: boolean;
}

/**
 * Writes the current ZSET into `contest.standings_snapshots` + `standings_rows`.
 *
 * The rows are inserted in one statement per chunk so a 50k-participant contest
 * is a handful of round trips, not 50k.
 */
export async function snapshotStandings(
  db: DatabaseHandles,
  deps: ScoringDeps,
  contest: ContestRow,
  kind: 'freeze' | 'final',
): Promise<SnapshotResult> {
  const board = await readWholeBoard(deps.redis, contest.id);

  const inserted = await db.primary
    .insert(standingsSnapshots)
    .values({ contestId: contest.id, kind, participantCount: board.length })
    .onConflictDoNothing({
      target: [standingsSnapshots.contestId, standingsSnapshots.kind],
    })
    .returning({ id: standingsSnapshots.id });

  const existingId = inserted[0]?.id;
  if (existingId === undefined) {
    const rows = await db.primary
      .select({ id: standingsSnapshots.id, participantCount: standingsSnapshots.participantCount })
      .from(standingsSnapshots)
      .where(
        and(eq(standingsSnapshots.contestId, contest.id), eq(standingsSnapshots.kind, kind)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new ApiError('internal-error', 'Standings snapshot vanished between write and read.');
    }
    return {
      snapshotId: row.id,
      kind,
      participantCount: row.participantCount,
      created: false,
    };
  }

  const CHUNK = 500;
  for (let i = 0; i < board.length; i += CHUNK) {
    const chunk = board.slice(i, i + CHUNK);
    await db.primary
      .insert(standingsRows)
      .values(
        chunk.map((entry) => ({
          snapshotId: existingId,
          rank: entry.rank,
          userId: entry.userId,
          points: entry.points,
          penaltySeconds: entry.penaltySeconds,
          solved: Object.fromEntries(
            Object.entries(entry.solved).map(([problemId, detail]) => [
              problemId,
              { solvedAt: detail.solvedAt, attempts: detail.attempts },
            ]),
          ),
        })),
      )
      .onConflictDoNothing();
  }

  return { snapshotId: existingId, kind, participantCount: board.length, created: true };
}

/**
 * §6 freeze. The broadcaster reads `frozen:{contest}` and stops publishing; the
 * scoring script keeps mutating the ZSET, which is what makes the final board
 * correct rather than merely late.
 */
export async function freezeContest(
  db: DatabaseHandles,
  deps: ScoringDeps,
  contest: ContestRow,
): Promise<SnapshotResult> {
  const snapshot = await snapshotStandings(db, deps, contest, 'freeze');

  await deps.redis.set(
    keys.contestFrozen(contest.id),
    snapshot.snapshotId,
    'EX',
    Math.max(3_600, Math.ceil((contest.endsAt.getTime() + 86_400_000 - Date.now()) / 1000)),
  );

  await db.primary
    .update(contests)
    .set({ status: 'frozen', updatedAt: new Date() })
    .where(and(eq(contests.id, contest.id), eq(contests.status, 'running')));

  await deps.publisher.publish(
    keys.wsContest(contest.id),
    JSON.stringify({ kind: 'freeze', contestId: contest.id, at: Date.now() }),
  );

  return snapshot;
}

export interface RatingChange {
  userId: string;
  rank: number;
  before: Rating;
  after: Rating;
}

export interface FinaliseResult {
  snapshotId: string;
  participantCount: number;
  ratedCount: number;
  ratingChanges: RatingChange[];
  /** True when the contest was already finalised and nothing changed. */
  alreadyFinalised: boolean;
}

/**
 * Users excluded from ratings: anti-cheat flagged anybody with a flagged
 * submission in this contest (§6, "excluded from ratings").
 */
async function flaggedUserIds(db: DatabaseHandles, contestId: string): Promise<Set<string>> {
  const rows = await db.primary
    .selectDistinct({ userId: contestSubmissions.userId })
    .from(contestSubmissions)
    .where(
      and(eq(contestSubmissions.contestId, contestId), eq(contestSubmissions.flagged, true)),
    );
  return new Set(rows.map((row) => row.userId));
}

/**
 * The finaliser. Snapshots the board, computes Glicko-2 over the *live, rated*
 * participants in one batch, and writes ratings plus history.
 *
 * Virtual participants are excluded by construction: `contest.registrations`
 * forces `rated = false` for them (see the check constraint), because a virtual
 * run happens on the participant's own clock and cannot be compared with anyone.
 */
export async function finaliseContest(
  db: DatabaseHandles,
  deps: ScoringDeps,
  contest: ContestRow,
): Promise<FinaliseResult> {
  const already = await db.primary
    .select({ finalisedAt: contests.finalisedAt })
    .from(contests)
    .where(eq(contests.id, contest.id))
    .limit(1);

  const snapshot = await snapshotStandings(db, deps, contest, 'final');

  if (already[0]?.finalisedAt) {
    return {
      snapshotId: snapshot.snapshotId,
      participantCount: snapshot.participantCount,
      ratedCount: 0,
      ratingChanges: [],
      alreadyFinalised: true,
    };
  }

  await db.primary
    .update(contests)
    .set({ status: 'finalising', updatedAt: new Date() })
    .where(eq(contests.id, contest.id));

  const rows = await db.primary
    .select({
      snapshotId: standingsRows.snapshotId,
      rank: standingsRows.rank,
      userId: standingsRows.userId,
      points: standingsRows.points,
      penaltySeconds: standingsRows.penaltySeconds,
    })
    .from(standingsRows)
    .where(eq(standingsRows.snapshotId, snapshot.snapshotId));

  const ratingChanges: RatingChange[] = [];
  let ratedCount = 0;

  if (contest.kind === 'rated') {
    const registered = await db.primary
      .select({ userId: registrations.userId })
      .from(registrations)
      .where(
        and(
          eq(registrations.contestId, contest.id),
          eq(registrations.kind, 'live'),
          eq(registrations.rated, true),
        ),
      );

    const excluded = await flaggedUserIds(db, contest.id);
    const eligible = registered.map((r) => r.userId).filter((id) => !excluded.has(id));

    if (eligible.length >= 2) {
      const current =
        eligible.length > 0
          ? await db.primary
              .select({
                userId: ratingsTable.userId,
                rating: ratingsTable.rating,
                ratingDeviation: ratingsTable.ratingDeviation,
                volatility: ratingsTable.volatility,
                contestsPlayed: ratingsTable.contestsPlayed,
                peakRating: ratingsTable.peakRating,
              })
              .from(ratingsTable)
              .where(inArray(ratingsTable.userId, eligible))
          : [];

      const priorById = new Map(current.map((row) => [row.userId, row]));
      const rankById = new Map(rows.map((row) => [row.userId, row.rank] as const));
      // Anyone registered but absent from the board solved nothing; they place
      // last, jointly, which is the correct comparison against everybody who did.
      const lastRank = rows.length + 1;

      const participants: ContestParticipant[] = eligible.map((userId) => {
        const prior = priorById.get(userId);
        return {
          id: userId,
          rank: rankById.get(userId) ?? lastRank,
          rating: {
            rating: prior?.rating ?? 1500,
            rd: prior?.ratingDeviation ?? DEFAULT_CONFIG.initialRd,
            volatility: prior?.volatility ?? DEFAULT_CONFIG.initialVolatility,
          },
        };
      });

      const rated = rateContest(participants, DEFAULT_CONFIG);
      ratedCount = rated.size;

      for (const participant of participants) {
        const after = rated.get(participant.id);
        if (!after) continue;

        const prior = priorById.get(participant.id);
        await db.primary
          .insert(ratingsTable)
          .values({
            userId: participant.id,
            rating: after.rating,
            ratingDeviation: after.rd,
            volatility: after.volatility,
            contestsPlayed: (prior?.contestsPlayed ?? 0) + 1,
            peakRating: Math.max(prior?.peakRating ?? 1500, after.rating),
            lastContestId: contest.id,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: ratingsTable.userId,
            set: {
              rating: after.rating,
              ratingDeviation: after.rd,
              volatility: after.volatility,
              contestsPlayed: sql`${ratingsTable.contestsPlayed} + 1`,
              peakRating: sql`greatest(${ratingsTable.peakRating}, ${after.rating})`,
              lastContestId: contest.id,
              updatedAt: new Date(),
            },
          });

        await db.primary
          .insert(ratingHistory)
          .values({
            userId: participant.id,
            contestId: contest.id,
            rank: participant.rank,
            ratingBefore: participant.rating.rating,
            rdBefore: participant.rating.rd,
            volatilityBefore: participant.rating.volatility,
            ratingAfter: after.rating,
            rdAfter: after.rd,
            volatilityAfter: after.volatility,
          })
          .onConflictDoNothing();

        ratingChanges.push({
          userId: participant.id,
          rank: participant.rank,
          before: participant.rating,
          after,
        });
      }
    }
  }

  await db.primary
    .update(contests)
    .set({ status: 'finalised', finalisedAt: new Date(), updatedAt: new Date() })
    .where(eq(contests.id, contest.id));

  await deps.redis.del(keys.contestFrozen(contest.id));
  await deps.publisher.publish(
    keys.wsContest(contest.id),
    JSON.stringify({
      kind: 'final',
      contestId: contest.id,
      snapshotId: snapshot.snapshotId,
      at: Date.now(),
    }),
  );

  return {
    snapshotId: snapshot.snapshotId,
    participantCount: snapshot.participantCount,
    ratedCount,
    ratingChanges,
    alreadyFinalised: false,
  };
}

/** Reads a stored snapshot back, for the frozen public board and for replays. */
export async function readSnapshot(
  db: DatabaseHandles,
  contestId: string,
  kind: 'freeze' | 'final',
  options: { limit: number; offset: number },
): Promise<{ takenAt: Date; total: number; entries: StandingsEntry[] } | null> {
  const snapshots = await db.replica
    .select({
      id: standingsSnapshots.id,
      takenAt: standingsSnapshots.takenAt,
      participantCount: standingsSnapshots.participantCount,
    })
    .from(standingsSnapshots)
    .where(and(eq(standingsSnapshots.contestId, contestId), eq(standingsSnapshots.kind, kind)))
    .limit(1);

  const snapshot = snapshots[0];
  if (!snapshot) return null;

  const rows = await db.replica
    .select({
      rank: standingsRows.rank,
      userId: standingsRows.userId,
      points: standingsRows.points,
      penaltySeconds: standingsRows.penaltySeconds,
      solved: standingsRows.solved,
    })
    .from(standingsRows)
    .where(eq(standingsRows.snapshotId, snapshot.id))
    .orderBy(standingsRows.rank)
    .limit(options.limit)
    .offset(options.offset);

  return {
    takenAt: snapshot.takenAt,
    total: snapshot.participantCount,
    entries: rows.map((row) => ({
      rank: row.rank,
      userId: row.userId,
      points: row.points,
      penaltySeconds: row.penaltySeconds,
      solved: Object.fromEntries(
        Object.entries(row.solved).map(([problemId, detail]) => [
          problemId,
          { solvedAt: detail.solvedAt, attempts: detail.attempts, points: 0 },
        ]),
      ),
    })),
  };
}

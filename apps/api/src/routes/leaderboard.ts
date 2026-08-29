/**
 * Leaderboards: global, per-contest and per-institution.
 *
 * §5 puts leaderboards in Redis as sorted sets, and §1 budgets dashboards at 75
 * rps with "cache + ETag". So the global and institution boards are ZSETs kept
 * in step by `progress/service.ts`, and the only Postgres work here is turning
 * user ids into handles.
 *
 * The ZSET is a cache of an append-only truth (`progress.xp_events`), so it can
 * be rebuilt: a cold or flushed key is repopulated from the ledger on first read
 * rather than returning an empty board.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ratings } from '../db/schema/contest.js';
import { orgs, users } from '../db/schema/identity.js';
import { xpEvents } from '../db/schema/progress.js';
import { problem } from '../errors.js';
import { readSnapshot } from '../contest/finaliser.js';
import { isFrozen, readStandings, type ContestWindow } from '../contest/scoring.js';
import { contests } from '../db/schema/contest.js';
import { keys } from '../redis/scripts.js';
import { and } from 'drizzle-orm';
import {
  cachePublic,
  page,
  paginationSchema,
  rateLimit,
  readParams,
  readQuery,
} from './helpers.js';

const REBUILD_TTL_SECONDS = 900;

interface BoardRow {
  rank: number;
  userId: string;
  score: number;
}

export const leaderboardRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis } = app.services;
  app.addHook('preHandler', rateLimit(app, 'read'));

  /**
   * Reads a page of a ZSET. Ties share a rank, so two users with the same XP
   * never appear to swap places between two reads of identical state.
   */
  async function readBoard(
    key: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: BoardRow[]; total: number }> {
    const total = await redis.client.zcard(key);
    if (total === 0) return { rows: [], total: 0 };

    const flat = await redis.client.zrevrange(key, offset, offset + limit - 1, 'WITHSCORES');
    const rows: BoardRow[] = [];
    let previousScore: number | null = null;
    let previousRank = offset + 1;

    for (let i = 0; i < flat.length; i += 2) {
      const userId = flat[i] as string;
      const score = Number(flat[i + 1]);
      const index = offset + i / 2 + 1;
      const rank = previousScore !== null && score === previousScore ? previousRank : index;
      previousScore = score;
      previousRank = rank;
      rows.push({ rank, userId, score });
    }

    return { rows, total };
  }

  /** Rebuilds a cold ZSET from the append-only XP ledger. */
  async function rebuildFromLedger(key: string, orgId: string | null): Promise<number> {
    const rows = orgId
      ? await db.replica
          .select({
            userId: xpEvents.userId,
            total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)::int`,
          })
          .from(xpEvents)
          .innerJoin(users, eq(users.id, xpEvents.userId))
          .where(eq(users.orgId, orgId))
          .groupBy(xpEvents.userId)
      : await db.replica
          .select({
            userId: xpEvents.userId,
            total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)::int`,
          })
          .from(xpEvents)
          .groupBy(xpEvents.userId);

    if (rows.length === 0) return 0;

    const pipeline = redis.client.multi();
    for (const row of rows) {
      if (row.total > 0) pipeline.zadd(key, row.total, row.userId);
    }
    // A rebuilt board is a cache, not the truth, so it is allowed to expire and
    // be rebuilt again rather than drifting quietly for ever.
    pipeline.expire(key, REBUILD_TTL_SECONDS);
    await pipeline.exec();
    return rows.length;
  }

  async function decorate(rows: BoardRow[]) {
    if (rows.length === 0) return [];
    const profiles = await db.replica
      .select({
        id: users.id,
        handle: users.handle,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        orgId: users.orgId,
      })
      .from(users)
      .where(inArray(users.id, rows.map((row) => row.userId)));

    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    return rows.map((row) => ({
      rank: row.rank,
      userId: row.userId,
      score: row.score,
      handle: byId.get(row.userId)?.handle ?? null,
      displayName: byId.get(row.userId)?.displayName ?? null,
      avatarUrl: byId.get(row.userId)?.avatarUrl ?? null,
    }));
  }

  app.get('/global', async (request, reply) => {
    const query = readQuery(request, paginationSchema);
    const key = keys.globalLeaderboard();

    let board = await readBoard(key, query.limit, query.offset);
    if (board.total === 0) {
      await rebuildFromLedger(key, null);
      board = await readBoard(key, query.limit, query.offset);
    }

    return reply
      .header('cache-control', cachePublic(30))
      .send({ metric: 'xp', ...page(await decorate(board.rows), query, board.total) });
  });

  /** Glicko-2 ratings (§6), which are a different ordering from XP. */
  app.get('/ratings', async (request, reply) => {
    const query = readQuery(request, paginationSchema);

    const rows = await db.replica
      .select({
        userId: ratings.userId,
        rating: ratings.rating,
        ratingDeviation: ratings.ratingDeviation,
        contestsPlayed: ratings.contestsPlayed,
        peakRating: ratings.peakRating,
        handle: users.handle,
        displayName: users.displayName,
      })
      .from(ratings)
      .innerJoin(users, eq(users.id, ratings.userId))
      .where(sql`${ratings.contestsPlayed} > 0`)
      .orderBy(desc(ratings.rating))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.replica
      .select({ total: sql<number>`count(*)::int` })
      .from(ratings)
      .where(sql`${ratings.contestsPlayed} > 0`);

    return reply.header('cache-control', cachePublic(60)).send(
      page(
        rows.map((row, index) => ({ rank: query.offset + index + 1, ...row })),
        query,
        counted[0]?.total ?? 0,
      ),
    );
  });

  app.get('/contests/:contestId', async (request, reply) => {
    const { contestId } = readParams(request, z.object({ contestId: z.string().uuid() }));
    const query = readQuery(request, paginationSchema);

    const rows = await db.replica
      .select({
        id: contests.id,
        slug: contests.slug,
        status: contests.status,
        startsAt: contests.startsAt,
        endsAt: contests.endsAt,
        freezeMinutes: contests.freezeMinutes,
        penaltySecondsPerReject: contests.penaltySecondsPerReject,
      })
      .from(contests)
      .where(eq(contests.id, contestId))
      .limit(1);

    const contest = rows[0];
    if (!contest) throw problem.notFound('Contest');

    const now = new Date();
    const frozen = isFrozen(contest as ContestWindow, now);

    if (frozen || contest.status === 'finalised') {
      const snapshot = await readSnapshot(
        db,
        contest.id,
        contest.status === 'finalised' ? 'final' : 'freeze',
        query,
      );
      if (snapshot) {
        const decorated = await decorate(
          snapshot.entries.map((entry) => ({
            rank: entry.rank,
            userId: entry.userId,
            score: entry.points,
          })),
        );
        return reply.header('cache-control', cachePublic(30)).send({
          frozen,
          final: contest.status === 'finalised',
          source: 'snapshot',
          takenAt: snapshot.takenAt.toISOString(),
          ...page(
            decorated.map((row, index) => ({
              ...row,
              penaltySeconds: snapshot.entries[index]?.penaltySeconds ?? 0,
            })),
            query,
            snapshot.total,
          ),
        });
      }
    }

    const board = await readStandings(redis.client, contest.id, {
      limit: query.limit,
      offset: query.offset,
    });

    const decorated = await decorate(
      board.entries.map((entry) => ({
        rank: entry.rank,
        userId: entry.userId,
        score: entry.points,
      })),
    );

    return reply.header('cache-control', cachePublic(10)).send({
      frozen,
      final: false,
      source: 'live',
      ...page(
        decorated.map((row, index) => ({
          ...row,
          penaltySeconds: board.entries[index]?.penaltySeconds ?? 0,
        })),
        query,
        board.total,
      ),
    });
  });

  /**
   * Institution board. Visible to members of the institution and to admins:
   * a Campus customer's internal ranking is not public information.
   */
  app.get('/institutions/:orgId', async (request, reply) => {
    const { orgId } = readParams(request, z.object({ orgId: z.string().uuid() }));
    const query = readQuery(request, paginationSchema);

    const auth = request.auth;
    if (!auth) throw problem.unauthorized();
    if (auth.role !== 'admin' && auth.orgId !== orgId) {
      throw problem.forbidden('You are not a member of this institution.');
    }

    const orgRows = await db.replica
      .select({ id: orgs.id, name: orgs.name, slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    const org = orgRows[0];
    if (!org) throw problem.notFound('Organisation');

    const key = keys.institutionLeaderboard(orgId);
    let board = await readBoard(key, query.limit, query.offset);
    if (board.total === 0) {
      await rebuildFromLedger(key, orgId);
      board = await readBoard(key, query.limit, query.offset);
    }

    return reply.send({
      org: { id: org.id, name: org.name, slug: org.slug },
      metric: 'xp',
      ...page(await decorate(board.rows), query, board.total),
    });
  });

  /** The caller's own position, which a paged board rarely contains. */
  app.get('/me', async (request, reply) => {
    const auth = request.auth;
    if (!auth) throw problem.unauthorized();

    const globalKey = keys.globalLeaderboard();
    const [globalRank, globalScore, total] = await Promise.all([
      redis.client.zrevrank(globalKey, auth.userId),
      redis.client.zscore(globalKey, auth.userId),
      redis.client.zcard(globalKey),
    ]);

    const institution = auth.orgId
      ? await (async () => {
          const key = keys.institutionLeaderboard(auth.orgId as string);
          const [rank, size] = await Promise.all([
            redis.client.zrevrank(key, auth.userId),
            redis.client.zcard(key),
          ]);
          return { rank: rank === null ? null : rank + 1, total: size };
        })()
      : null;

    const ratingRows = await db.replica
      .select({
        rating: ratings.rating,
        ratingDeviation: ratings.ratingDeviation,
        contestsPlayed: ratings.contestsPlayed,
        peakRating: ratings.peakRating,
      })
      .from(ratings)
      .where(and(eq(ratings.userId, auth.userId)))
      .limit(1);

    return reply.send({
      global: {
        rank: globalRank === null ? null : globalRank + 1,
        score: globalScore === null ? 0 : Number(globalScore),
        total,
      },
      institution,
      rating: ratingRows[0] ?? null,
    });
  });
};

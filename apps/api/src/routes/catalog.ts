/**
 * The catalogue (system-design §5: "small, read-mostly, fully cached").
 *
 * Every response here is derived from tables that change only when content ships,
 * so the handlers set a long `Cache-Control` and lean on a short-lived Redis
 * cache in front of Postgres. §1 budgets 611 rps of lesson reads with "95%+
 * CDN-cacheable"; that only holds if the origin actually says so.
 *
 * Plan gating (§7, "Lessons: T0-T1" on Free) is applied to *content*, never to
 * structure: an unentitled learner still sees that T5 exists and what it covers,
 * they just do not get the lesson body.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  companies,
  conceptEdges,
  concepts,
  lessonConcepts,
  lessonPrereqs,
  lessons,
  modules,
  questions,
  roadmaps,
  tracks,
} from '../db/schema/catalog.js';
import { canReadTrack, interviewBankSize } from '../entitlements/index.js';
import { problem } from '../errors.js';
import { keys } from '../redis/scripts.js';
import { cachePublic, page, paginationSchema, rateLimit, readParams, readQuery } from './helpers.js';

const CATALOG_TTL_SECONDS = 300;

const trackCodeSchema = z.object({ code: z.string().regex(/^T[0-9]$/) });
const moduleCodeSchema = z.object({ code: z.string().regex(/^T[0-9][A-D]?\.M[0-9]+$/) });
const slugSchema = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,126}$/) });

const searchSchema = paginationSchema.extend({
  q: z.string().trim().min(2).max(120),
  kind: z.enum(['all', 'lessons', 'concepts']).default('all'),
});

const questionQuerySchema = paginationSchema.extend({
  kind: z.enum(['coding', 'system_design', 'conceptual']).optional(),
  companySlug: z.string().max(64).optional(),
  difficulty: z.coerce.number().int().min(1).max(5).optional(),
});

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis } = app.services;
  const readLimit = rateLimit(app, 'read');

  app.addHook('preHandler', readLimit);

  /**
   * Small read-through cache. The catalogue changes on a content deploy, so a
   * five-minute TTL is a rounding error against the 9,000 QPS read budget in §1
   * and removes the query entirely for the hot paths.
   */
  async function cached<T>(name: string, load: () => Promise<T>): Promise<T> {
    const key = keys.catalogCache(name);
    try {
      const hit = await redis.client.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch {
      // A cache read failure must not take the catalogue down.
    }
    const value = await load();
    await redis.client
      .set(key, JSON.stringify(value), 'EX', CATALOG_TTL_SECONDS)
      .catch(() => undefined);
    return value;
  }

  app.get('/tracks', async (request, reply) => {
    const items = await cached('tracks', async () =>
      db.replica
        .select({
          id: tracks.id,
          code: tracks.code,
          slug: tracks.slug,
          title: tracks.title,
          subtitle: tracks.subtitle,
          description: tracks.description,
          level: tracks.level,
          position: tracks.position,
          moduleCount: tracks.moduleCount,
          lessonCount: tracks.lessonCount,
          freeTier: tracks.freeTier,
        })
        .from(tracks)
        .orderBy(asc(tracks.position)),
    );

    const entitlements = request.entitlements;
    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({
      items: items.map((track) => ({
        ...track,
        readable: entitlements ? canReadTrack(entitlements, track.code) : track.freeTier,
      })),
    });
  });

  app.get('/tracks/:code', async (request, reply) => {
    const { code } = readParams(request, trackCodeSchema);

    const found = await cached(`track:${code}`, async () => {
      const trackRows = await db.replica
        .select()
        .from(tracks)
        .where(eq(tracks.code, code))
        .limit(1);
      const track = trackRows[0];
      if (!track) return null;

      const moduleRows = await db.replica
        .select({
          id: modules.id,
          code: modules.code,
          slug: modules.slug,
          title: modules.title,
          summary: modules.summary,
          level: modules.level,
          position: modules.position,
          lessonCount: modules.lessonCount,
        })
        .from(modules)
        .where(eq(modules.trackId, track.id))
        .orderBy(asc(modules.position));

      return { track, modules: moduleRows };
    });

    if (!found) throw problem.notFound('Track');

    const entitlements = request.entitlements;
    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({
      track: {
        id: found.track.id,
        code: found.track.code,
        slug: found.track.slug,
        title: found.track.title,
        subtitle: found.track.subtitle,
        description: found.track.description,
        level: found.track.level,
        position: found.track.position,
        moduleCount: found.track.moduleCount,
        lessonCount: found.track.lessonCount,
        freeTier: found.track.freeTier,
        readable: entitlements ? canReadTrack(entitlements, found.track.code) : found.track.freeTier,
      },
      modules: found.modules,
    });
  });

  app.get('/modules/:code', async (request, reply) => {
    const { code } = readParams(request, moduleCodeSchema);

    const found = await cached(`module:${code}`, async () => {
      const moduleRows = await db.replica
        .select({
          module: modules,
          trackCode: tracks.code,
          trackTitle: tracks.title,
        })
        .from(modules)
        .innerJoin(tracks, eq(tracks.id, modules.trackId))
        .where(eq(modules.code, code))
        .limit(1);

      const row = moduleRows[0];
      if (!row) return null;

      const lessonRows = await db.replica
        .select({
          id: lessons.id,
          slug: lessons.slug,
          title: lessons.title,
          kind: lessons.kind,
          level: lessons.level,
          position: lessons.position,
          estimatedMinutes: lessons.estimatedMinutes,
          xp: lessons.xp,
          freeTier: lessons.freeTier,
        })
        .from(lessons)
        .where(eq(lessons.moduleId, row.module.id))
        .orderBy(asc(lessons.position));

      return { row, lessons: lessonRows };
    });

    if (!found) throw problem.notFound('Module');

    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({
      module: {
        id: found.row.module.id,
        code: found.row.module.code,
        slug: found.row.module.slug,
        title: found.row.module.title,
        summary: found.row.module.summary,
        level: found.row.module.level,
        position: found.row.module.position,
        lessonCount: found.row.module.lessonCount,
        trackCode: found.row.trackCode,
        trackTitle: found.row.trackTitle,
      },
      lessons: found.lessons,
    });
  });

  app.get('/lessons/:slug', async (request, reply) => {
    const { slug } = readParams(request, slugSchema);

    const found = await cached(`lesson:${slug}`, async () => {
      const rows = await db.replica
        .select({
          lesson: lessons,
          moduleCode: modules.code,
          moduleTitle: modules.title,
          trackCode: tracks.code,
          trackTitle: tracks.title,
        })
        .from(lessons)
        .innerJoin(modules, eq(modules.id, lessons.moduleId))
        .innerJoin(tracks, eq(tracks.id, modules.trackId))
        .where(eq(lessons.slug, slug))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const prereqs = await db.replica
        .select({
          lessonId: lessonPrereqs.prereqLessonId,
          hard: lessonPrereqs.hard,
          slug: lessons.slug,
          title: lessons.title,
        })
        .from(lessonPrereqs)
        .innerJoin(lessons, eq(lessons.id, lessonPrereqs.prereqLessonId))
        .where(eq(lessonPrereqs.lessonId, row.lesson.id));

      const linkedConcepts = await db.replica
        .select({
          id: concepts.id,
          slug: concepts.slug,
          title: concepts.title,
          weight: lessonConcepts.weight,
        })
        .from(lessonConcepts)
        .innerJoin(concepts, eq(concepts.id, lessonConcepts.conceptId))
        .where(eq(lessonConcepts.lessonId, row.lesson.id));

      return { row, prereqs, concepts: linkedConcepts };
    });

    if (!found) throw problem.notFound('Lesson');

    const entitlements = request.entitlements;
    const readable =
      found.row.lesson.freeTier ||
      (entitlements ? canReadTrack(entitlements, found.row.trackCode) : false);

    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({
      lesson: {
        id: found.row.lesson.id,
        slug: found.row.lesson.slug,
        title: found.row.lesson.title,
        kind: found.row.lesson.kind,
        level: found.row.lesson.level,
        position: found.row.lesson.position,
        estimatedMinutes: found.row.lesson.estimatedMinutes,
        xp: found.row.lesson.xp,
        passThreshold: found.row.lesson.passThreshold,
        freeTier: found.row.lesson.freeTier,
        graderKey: found.row.lesson.graderKey,
        // The MDX body is served by the web tier from the CDN; the gateway hands
        // out the pointer and the entitlement decision, not the megabytes.
        mdxPath: readable ? found.row.lesson.mdxPath : null,
        moduleCode: found.row.moduleCode,
        moduleTitle: found.row.moduleTitle,
        trackCode: found.row.trackCode,
        trackTitle: found.row.trackTitle,
      },
      readable,
      requiredPlan: readable ? null : 'pro',
      prereqs: found.prereqs,
      concepts: found.concepts,
    });
  });

  /** The concept DAG: nodes plus prerequisite and related edges. */
  app.get('/concepts', async (request, reply) => {
    const { trackCode } = readQuery(
      request,
      z.object({ trackCode: z.string().regex(/^T[0-9]$/).optional() }),
    );

    const graph = await cached(`concepts:${trackCode ?? 'all'}`, async () => {
      const nodes = trackCode
        ? await db.replica
            .select({
              id: concepts.id,
              slug: concepts.slug,
              title: concepts.title,
              description: concepts.description,
              trackId: concepts.trackId,
            })
            .from(concepts)
            .innerJoin(tracks, eq(tracks.id, concepts.trackId))
            .where(eq(tracks.code, trackCode))
            .orderBy(asc(concepts.id))
        : await db.replica
            .select({
              id: concepts.id,
              slug: concepts.slug,
              title: concepts.title,
              description: concepts.description,
              trackId: concepts.trackId,
            })
            .from(concepts)
            .orderBy(asc(concepts.id));

      const ids = nodes.map((node) => node.id);
      const edges =
        ids.length === 0
          ? []
          : await db.replica
              .select({
                from: conceptEdges.fromConceptId,
                to: conceptEdges.toConceptId,
                kind: conceptEdges.kind,
                weight: conceptEdges.weight,
              })
              .from(conceptEdges)
              .where(
                and(
                  inArray(conceptEdges.fromConceptId, ids),
                  inArray(conceptEdges.toConceptId, ids),
                ),
              );

      return { nodes, edges };
    });

    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send(graph);
  });

  app.get('/concepts/:slug', async (request, reply) => {
    const { slug } = readParams(request, slugSchema);

    const rows = await db.replica
      .select()
      .from(concepts)
      .where(eq(concepts.slug, slug))
      .limit(1);

    const concept = rows[0];
    if (!concept) throw problem.notFound('Concept');

    const [prereqRows, unlocksRows, lessonRows] = await Promise.all([
      db.replica
        .select({ id: concepts.id, slug: concepts.slug, title: concepts.title, kind: conceptEdges.kind })
        .from(conceptEdges)
        .innerJoin(concepts, eq(concepts.id, conceptEdges.fromConceptId))
        .where(eq(conceptEdges.toConceptId, concept.id)),
      db.replica
        .select({ id: concepts.id, slug: concepts.slug, title: concepts.title, kind: conceptEdges.kind })
        .from(conceptEdges)
        .innerJoin(concepts, eq(concepts.id, conceptEdges.toConceptId))
        .where(eq(conceptEdges.fromConceptId, concept.id)),
      db.replica
        .select({ id: lessons.id, slug: lessons.slug, title: lessons.title, weight: lessonConcepts.weight })
        .from(lessonConcepts)
        .innerJoin(lessons, eq(lessons.id, lessonConcepts.lessonId))
        .where(eq(lessonConcepts.conceptId, concept.id)),
    ]);

    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({
      concept: {
        id: concept.id,
        slug: concept.slug,
        title: concept.title,
        description: concept.description,
        trackId: concept.trackId,
        bkt: {
          prior: concept.priorMastery,
          learn: concept.learnRate,
          slip: concept.slipRate,
          guess: concept.guessRate,
        },
      },
      prereqs: prereqRows,
      unlocks: unlocksRows,
      lessons: lessonRows,
    });
  });

  app.get('/roadmaps', async (_request, reply) => {
    const items = await cached('roadmaps', async () =>
      db.replica.select().from(roadmaps).orderBy(asc(roadmaps.position)),
    );
    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({ items });
  });

  app.get('/roadmaps/:slug', async (request, reply) => {
    const { slug } = readParams(request, slugSchema);
    const rows = await db.replica.select().from(roadmaps).where(eq(roadmaps.slug, slug)).limit(1);
    const roadmap = rows[0];
    if (!roadmap) throw problem.notFound('Roadmap');

    // The stored path is a list of module codes; resolve them so a client does
    // not have to make N follow-up requests to render the roadmap.
    const moduleRows =
      roadmap.path.length === 0
        ? []
        : await db.replica
            .select({
              code: modules.code,
              slug: modules.slug,
              title: modules.title,
              level: modules.level,
              lessonCount: modules.lessonCount,
              trackCode: tracks.code,
            })
            .from(modules)
            .innerJoin(tracks, eq(tracks.id, modules.trackId))
            .where(inArray(modules.code, roadmap.path));

    const byCode = new Map(moduleRows.map((row) => [row.code, row]));

    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({
      roadmap: {
        id: roadmap.id,
        slug: roadmap.slug,
        title: roadmap.title,
        persona: roadmap.persona,
        durationWeeks: roadmap.durationWeeks,
        position: roadmap.position,
      },
      // Preserves the roadmap's own ordering, dropping codes that no longer exist.
      path: roadmap.path.map((code) => byCode.get(code)).filter((row) => row !== undefined),
    });
  });

  /**
   * Full-text search over the stored `tsvector` generated columns, so the index
   * can never drift from the row (see `catalog.ts` in the schema).
   */
  app.get('/search', async (request, reply) => {
    const query = readQuery(request, searchSchema);
    const tsQuery = sql`websearch_to_tsquery('english', ${query.q})`;

    const lessonHits =
      query.kind === 'concepts'
        ? []
        : await db.replica
            .select({
              type: sql<string>`'lesson'`,
              id: lessons.id,
              slug: lessons.slug,
              title: lessons.title,
              trackCode: tracks.code,
              rank: sql<number>`ts_rank(${lessons.searchVector}, ${tsQuery})`,
            })
            .from(lessons)
            .innerJoin(modules, eq(modules.id, lessons.moduleId))
            .innerJoin(tracks, eq(tracks.id, modules.trackId))
            .where(sql`${lessons.searchVector} @@ ${tsQuery}`)
            .orderBy(desc(sql`ts_rank(${lessons.searchVector}, ${tsQuery})`))
            .limit(query.limit);

    const conceptHits =
      query.kind === 'lessons'
        ? []
        : await db.replica
            .select({
              type: sql<string>`'concept'`,
              id: concepts.id,
              slug: concepts.slug,
              title: concepts.title,
              trackCode: sql<string | null>`null`,
              rank: sql<number>`ts_rank(${concepts.searchVector}, ${tsQuery})`,
            })
            .from(concepts)
            .where(sql`${concepts.searchVector} @@ ${tsQuery}`)
            .orderBy(desc(sql`ts_rank(${concepts.searchVector}, ${tsQuery})`))
            .limit(query.limit);

    const merged = [...lessonHits, ...conceptHits]
      .sort((a, b) => b.rank - a.rank)
      .slice(query.offset, query.offset + query.limit);

    return reply
      .header('cache-control', cachePublic(60))
      .send(page(merged, query, lessonHits.length + conceptHits.length));
  });

  /** §7: 20 questions on Free, the full 240 on every paid plan. */
  app.get('/questions', async (request, reply) => {
    const query = readQuery(request, questionQuerySchema);
    const entitlements = request.entitlements;
    const allowance = entitlements ? interviewBankSize(entitlements) : 20;

    const filters = [sql`${questions.position} <= ${allowance}`];
    if (query.kind) filters.push(eq(questions.kind, query.kind));
    if (query.difficulty !== undefined) filters.push(eq(questions.difficulty, query.difficulty));
    if (query.companySlug) filters.push(eq(companies.slug, query.companySlug));

    const rows = await db.replica
      .select({
        id: questions.id,
        slug: questions.slug,
        kind: questions.kind,
        title: questions.title,
        difficulty: questions.difficulty,
        position: questions.position,
        companySlug: companies.slug,
        companyName: companies.name,
      })
      .from(questions)
      .leftJoin(companies, eq(companies.id, questions.companyId))
      .where(and(...filters))
      .orderBy(asc(questions.position))
      .limit(query.limit)
      .offset(query.offset);

    const counted = await db.replica
      .select({ total: sql<number>`count(*)::int` })
      .from(questions)
      .leftJoin(companies, eq(companies.id, questions.companyId))
      .where(and(...filters));

    return reply.send({
      ...page(rows, query, counted[0]?.total ?? 0),
      allowance,
      plan: entitlements?.plan ?? 'free',
    });
  });

  app.get('/questions/:slug', async (request, reply) => {
    const { slug } = readParams(request, slugSchema);
    const entitlements = request.entitlements;
    const allowance = entitlements ? interviewBankSize(entitlements) : 20;

    const rows = await db.replica
      .select()
      .from(questions)
      .where(eq(questions.slug, slug))
      .limit(1);

    const question = rows[0];
    if (!question) throw problem.notFound('Question');

    if (question.position > allowance) {
      throw problem.forbidden(
        `This question is outside the ${allowance}-question bank included in your plan.`,
      );
    }

    return reply.send({ question });
  });

  app.get('/companies', async (_request, reply) => {
    const items = await cached('companies', async () =>
      db.replica.select().from(companies).orderBy(asc(companies.name)),
    );
    return reply.header('cache-control', cachePublic(CATALOG_TTL_SECONDS)).send({ items });
  });
};

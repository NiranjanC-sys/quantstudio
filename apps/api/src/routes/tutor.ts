/**
 * The AI tutor gateway (system-design §7 ceilings, §9 degradation step 3, §12
 * "the AI line is the one that can run away").
 *
 * This module is a *streaming proxy with a budget*. It never talks to a model
 * directly: it authorises, prices, opens an SSE stream to the tutor service and
 * accounts for what came back. Three ceilings apply, in this order:
 *
 *   1. per-plan messages/day  — the §7 matrix, enforced as a token bucket;
 *   2. per-user tokens/day    — §9's "50k token/day hard ceiling";
 *   3. per-hour spend, cell-wide — §12's hard stop, which downgrades the whole
 *      cell to retrieval-only rather than letting the bill run.
 *
 * And one hard prohibition: hints are disabled while the caller is registered in
 * a running rated contest. That is not a rate limit, it is an integrity rule, so
 * it fails closed and is checked before anything else.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { contests, registrations } from '../db/schema/contest.js';
import { ApiError } from '../errors.js';
import { createDegradationController } from '../lib/degradation.js';
import { keys } from '../redis/scripts.js';
import { authed, rateLimit, readBody, useIdempotency } from './helpers.js';

const messageSchema = z.object({
  /** `hint` is the mode a contest disables; the others stay available. */
  mode: z.enum(['chat', 'hint', 'explain', 'review']).default('chat'),
  message: z.string().trim().min(1).max(8_000),
  lessonId: z.number().int().positive().optional(),
  contestProblemId: z.string().uuid().optional(),
  /** Prior turns, trimmed by the caller; the gateway caps the total size. */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(8_000),
      }),
    )
    .max(20)
    .default([]),
});

interface TutorUsage {
  inputTokens: number;
  outputTokens: number;
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export const tutorRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis, env, metrics } = app.services;
  const degradation = createDegradationController(env, redis.client);

  useIdempotency(app);
  const tutorLimit = rateLimit(app, 'tutor');
  const readLimit = rateLimit(app, 'read');

  /**
   * §6 integrity: a learner registered in a *rated* contest that is currently
   * running cannot ask for hints. Virtual and unrated registrations are exempt —
   * neither affects anyone else's standing.
   */
  async function ratedContestInProgress(userId: string, now: Date): Promise<string | null> {
    const rows = await db.primary
      .select({ id: contests.id, slug: contests.slug })
      .from(registrations)
      .innerJoin(contests, eq(contests.id, registrations.contestId))
      .where(
        and(
          eq(registrations.userId, userId),
          eq(registrations.kind, 'live'),
          eq(registrations.rated, true),
          eq(contests.kind, 'rated'),
          sql`${contests.startsAt} <= ${now} and ${contests.endsAt} > ${now}`,
        ),
      )
      .limit(1);

    return rows[0]?.slug ?? null;
  }

  async function usageSnapshot(userId: string, now: Date) {
    const [tokens, messages, hourlyCost] = await Promise.all([
      redis.client.get(keys.tutorTokens(userId, dayKey(now))),
      redis.client.get(keys.tutorMessages(userId, dayKey(now))),
      redis.client.get(keys.tutorHourlyCost(hourKey(now))),
    ]);

    return {
      tokensToday: Number(tokens ?? 0),
      messagesToday: Number(messages ?? 0),
      cellCostThisHourUsd: Number(hourlyCost ?? 0),
    };
  }

  function priceUsd(usage: TutorUsage): number {
    return (
      (usage.inputTokens / 1000) * env.TUTOR_COST_PER_1K_INPUT_USD +
      (usage.outputTokens / 1000) * env.TUTOR_COST_PER_1K_OUTPUT_USD
    );
  }

  async function recordUsage(
    userId: string,
    plan: string,
    usage: TutorUsage,
    now: Date,
  ): Promise<void> {
    const cost = priceUsd(usage);
    const day = dayKey(now);
    const hour = hourKey(now);

    await redis.client
      .multi()
      .incrby(keys.tutorTokens(userId, day), usage.inputTokens + usage.outputTokens)
      .expire(keys.tutorTokens(userId, day), 172_800)
      .incr(keys.tutorMessages(userId, day))
      .expire(keys.tutorMessages(userId, day), 172_800)
      // Stored in micro-dollars so the counter stays integral in Redis.
      .incrby(keys.tutorHourlyCost(hour), Math.round(cost * 1_000_000))
      .expire(keys.tutorHourlyCost(hour), 7_200)
      .exec()
      .catch(() => undefined);

    metrics.tutorCostUsd.inc({ plan }, cost);
  }

  function writeEvent(reply: FastifyReply, event: string, data: unknown): void {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  app.get('/usage', { preHandler: [readLimit] }, async (request, reply) => {
    const auth = authed(request);
    const entitlements = request.entitlements ?? auth.entitlements;
    const now = new Date();
    const snapshot = await usageSnapshot(auth.userId, now);
    const state = await degradation.get();

    return reply.send({
      plan: entitlements.plan,
      messagesPerDay: entitlements.tutorMessagesPerDay,
      tokenCeilingPerDay: env.TUTOR_DAILY_TOKEN_CEILING,
      hourlyCostCeilingUsd: env.TUTOR_HOURLY_COST_CEILING_USD,
      ...snapshot,
      cellCostThisHourUsd: snapshot.cellCostThisHourUsd / 1_000_000,
      retrievalOnly: state.tutorRetrievalOnly,
      hintsBlockedByContest: (await ratedContestInProgress(auth.userId, now)) !== null,
    });
  });

  /**
   * Server-Sent Events proxy.
   *
   * `reply.hijack()` hands the socket to this handler: Fastify will not try to
   * serialise a body afterwards, which is what lets the response stay open for
   * the length of the model's answer.
   */
  app.post('/messages', { preHandler: [tutorLimit] }, async (request, reply) => {
    const auth = authed(request);
    const input = readBody(request, messageSchema);
    const entitlements = request.entitlements ?? auth.entitlements;
    const now = new Date();

    // 1. Integrity first. This one is not a budget and cannot be bought off.
    if (input.mode === 'hint') {
      const contestSlug = await ratedContestInProgress(auth.userId, now);
      if (contestSlug !== null) {
        throw new ApiError(
          'tutor-disabled-during-contest',
          'Hints are disabled while you are competing in a rated contest.',
          { extensions: { contest: contestSlug, mode: input.mode } },
        );
      }
    }

    // 2. §9: a hard per-user token ceiling on top of the per-plan message bucket.
    const usage = await usageSnapshot(auth.userId, now);
    if (usage.tokensToday >= env.TUTOR_DAILY_TOKEN_CEILING) {
      throw new ApiError(
        'tutor-budget-exhausted',
        `You have used the ${env.TUTOR_DAILY_TOKEN_CEILING} token daily ceiling.`,
        {
          extensions: {
            tokensToday: usage.tokensToday,
            ceiling: env.TUTOR_DAILY_TOKEN_CEILING,
          },
        },
      );
    }

    // 3. §12: the cell-wide hourly spend stop. Over budget the tutor degrades to
    //    retrieval-only (§9 step 3) rather than refusing outright, and says so.
    const state = await degradation.get();
    const hourlyUsd = usage.cellCostThisHourUsd / 1_000_000;
    const overSpend = hourlyUsd >= env.TUTOR_HOURLY_COST_CEILING_USD;
    const retrievalOnly = state.tutorRetrievalOnly || overSpend;

    const upstreamUrl = `${env.AI_TUTOR_URL}/v1/tutor/stream`;
    const serviceToken = await app.services.serviceTokens.mint({
      audience: 'ai-tutor',
      subject: auth.userId,
      scope: ['tutor:stream'],
      extra: { plan: entitlements.plan },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.AI_TUTOR_TIMEOUT_MS);
    request.raw.on('close', () => controller.abort());

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${serviceToken}`,
          'x-request-id': request.traceId,
        },
        body: JSON.stringify({
          mode: input.mode,
          message: input.message,
          history: input.history,
          lessonId: input.lessonId ?? null,
          contestProblemId: input.contestProblemId ?? null,
          userId: auth.userId,
          plan: entitlements.plan,
          // §9 step 3: the tutor answers from retrieval with citations and the
          // client is told, rather than being quietly given a worse answer.
          retrievalOnly,
          maxOutputTokens: Math.max(
            256,
            Math.min(2_048, env.TUTOR_DAILY_TOKEN_CEILING - usage.tokensToday),
          ),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new ApiError('upstream-unavailable', 'The AI tutor is unreachable.', {
        extensions: { service: 'ai-tutor' },
        retryAfterSeconds: 5,
        cause: error,
      });
    }

    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      throw new ApiError(
        'upstream-unavailable',
        `The AI tutor returned ${upstream.status}.`,
        { extensions: { service: 'ai-tutor', status: upstream.status }, retryAfterSeconds: 5 },
      );
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer by default, which turns a stream into a wait.
      'x-accel-buffering': 'no',
    });
    reply.hijack();

    writeEvent(reply, 'meta', {
      mode: input.mode,
      retrievalOnly,
      reason: overSpend ? 'hourly-cost-ceiling' : state.tutorRetrievalOnly ? 'operator' : null,
      plan: entitlements.plan,
      traceId: request.traceId,
    });

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = '';
    const totals: TutorUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        reply.raw.write(chunk);

        // Accounting is parsed out of the stream rather than trusted from a
        // trailer, so a client that disconnects early is still charged for what
        // the model actually produced.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '' || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as {
                usage?: { inputTokens?: number; outputTokens?: number };
              };
              if (parsed.usage) {
                totals.inputTokens = parsed.usage.inputTokens ?? totals.inputTokens;
                totals.outputTokens = parsed.usage.outputTokens ?? totals.outputTokens;
              }
            } catch {
              // Non-JSON frames are passthrough content, not accounting.
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      writeEvent(reply, 'usage', {
        ...totals,
        costUsd: Number(priceUsd(totals).toFixed(6)),
      });
      reply.raw.write('event: done\ndata: {}\n\n');
    } catch (error) {
      writeEvent(reply, 'error', {
        code: 'upstream-unavailable',
        detail: error instanceof Error ? error.message : 'The tutor stream ended unexpectedly.',
      });
    } finally {
      clearTimeout(timer);
      // If the model produced nothing measurable, charge the request itself, so
      // a stream that fails after generating tokens is never free.
      if (totals.inputTokens === 0 && totals.outputTokens === 0) {
        totals.inputTokens = Math.ceil(input.message.length / 4);
      }
      await recordUsage(auth.userId, entitlements.plan, totals, now);
      reply.raw.end();
    }
  });
};

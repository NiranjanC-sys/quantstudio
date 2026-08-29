/**
 * Liveness, readiness and metrics (system-design §11).
 *
 * `/healthz` answers from the process alone — if it needed Postgres, a database
 * blip would make Kubernetes kill every pod in the cell, which is precisely the
 * wrong response. `/readyz` is the one that checks dependencies, because a pod
 * that cannot reach Redis should leave the load-balancer pool but stay alive.
 */
import type { FastifyPluginAsync } from 'fastify';
import { readQuery } from './helpers.js';
import { z } from 'zod';

const readyQuerySchema = z.object({
  /** `?verbose=true` includes queue depths, which cost a round trip each. */
  verbose: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

interface DependencyReport {
  ok: boolean;
  latencyMs: number;
  detail?: Record<string, unknown>;
}

async function timed(probe: () => Promise<boolean>): Promise<DependencyReport> {
  const started = process.hrtime.bigint();
  const ok = await probe().catch(() => false);
  return { ok, latencyMs: Number(process.hrtime.bigint() - started) / 1e6 };
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const { db, redis, metrics, queues, env } = app.services;
  const startedAt = Date.now();

  app.get('/healthz', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      service: env.SERVICE_NAME,
      cell: env.CELL_ID,
      version: '1.0.0',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  });

  app.get('/readyz', async (request, reply) => {
    const { verbose } = readQuery(request, readyQuerySchema);

    const [database, cache] = await Promise.all([
      timed(async () => {
        const ping = await db.ping();
        return ping.primary;
      }),
      timed(() => redis.ping()),
    ]);

    const replica = await timed(async () => {
      const ping = await db.ping();
      return ping.replica;
    });

    // §9 step 6: reads keep working from replicas during a primary failover, so
    // a pod with a healthy replica and a healthy Redis is still useful. It is
    // reported as degraded, not unready, and writes fail closed at the route.
    const ready = cache.ok && (database.ok || replica.ok);
    const degraded = ready && !database.ok;

    const body: Record<string, unknown> = {
      status: ready ? (degraded ? 'degraded' : 'ok') : 'unready',
      cell: env.CELL_ID,
      checks: { database, replica, redis: cache },
    };

    if (verbose) {
      const depth = await queues.depth().catch(() => ({}));
      for (const [queue, count] of Object.entries(depth)) {
        metrics.graderLagSeconds.set({ queue }, count);
      }
      body['queues'] = depth;
    }

    return reply.status(ready ? 200 : 503).send(body);
  });

  /**
   * Prometheus scrape target. Left unauthenticated on purpose: it is bound
   * inside the cluster and carries no user data, and requiring a credential is
   * how scrape configs end up broken and unnoticed.
   */
  app.get('/metrics', async (_request, reply) => {
    if (!env.METRICS_ENABLED) {
      return reply.status(404).send({ status: 'metrics disabled' });
    }
    const body = await metrics.registry.metrics();
    return reply.type(metrics.registry.contentType).send(body);
  });
};

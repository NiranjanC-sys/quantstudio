/**
 * Process entry point.
 *
 * Configuration is validated once, at boot, by `loadEnv` — the process refuses
 * to start on invalid configuration rather than failing at the first request
 * that happens to need it.
 *
 * Shutdown is graceful in the way §9 needs it to be: on SIGTERM the instance
 * stops accepting connections, drains in-flight requests up to
 * `SHUTDOWN_GRACE_MS`, and only then closes the Postgres pools, the Redis
 * connections and the BullMQ producers. Killing those first would turn a rolling
 * deploy into a burst of 500s.
 */
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const built = await buildApp(env);
  const { app, services } = built;

  // §5: partitions must exist before the writes that need them, and the nightly
  // Stripe reconciliation (§7) has to be registered somewhere. Both are
  // idempotent, so every pod doing it at boot is harmless.
  await services.queues.installRepeatables().catch((error: unknown) => {
    app.log.error({ err: error }, 'could not install repeatable jobs');
  });

  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(
    { cell: env.CELL_ID, port: env.PORT, replica: services.db.hasReplica },
    'api gateway listening',
  );

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    // A hard deadline: if a request will not finish, the pod still has to go, and
    // Kubernetes' own grace period is the outer bound.
    const deadline = setTimeout(() => {
      app.log.error({ graceMs: env.SHUTDOWN_GRACE_MS }, 'shutdown deadline exceeded; exiting');
      process.exit(1);
    }, env.SHUTDOWN_GRACE_MS);
    deadline.unref();

    try {
      await built.close();
      clearTimeout(deadline);
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // An unhandled rejection has already escaped every error boundary the app has;
  // the honest response is to log it and let the orchestrator replace the pod.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet — a bad DATABASE_URL fails before Fastify is
  // constructed — so this one path writes to stderr directly.
  process.stderr.write(
    `fatal: api gateway failed to start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});

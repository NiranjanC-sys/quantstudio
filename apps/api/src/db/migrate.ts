/**
 * Migration runner.
 *
 * Drizzle's own `migrate()` is used so the journal in `src/db/migrations/meta`
 * stays the single source of truth for what has been applied. It runs against a
 * dedicated single connection rather than the pooled application handle: DDL and
 * PgBouncer transaction pooling do not mix, and a migration must not be able to
 * interleave with application traffic.
 *
 * Usage: `pnpm --filter @redquant/api db:migrate`
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { loadEnv } from '../env.js';

const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrateOptions {
  connectionString: string;
  /** Roll partitions forward after migrating (§5). Skipped for a bare schema. */
  ensurePartitions?: boolean;
}

export async function runMigrations(options: MigrateOptions): Promise<void> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();

  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    if (options.ensurePartitions !== false) {
      // Idempotent; also runs hourly from the maintenance queue.
      await db.execute(sql`select "ops"."ensure_partitions_ahead"(3, 6)`);
    }
  } finally {
    await client.end();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const env = loadEnv();
  runMigrations({ connectionString: env.DATABASE_URL })
    .then(() => {
      process.stdout.write('migrations applied\n');
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `migration failed\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    });
}

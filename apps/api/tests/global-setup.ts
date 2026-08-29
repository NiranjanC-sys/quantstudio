/**
 * Vitest global setup.
 *
 * Integration suites need a real Postgres and a real Redis, because the two
 * things they exist to prove — that the contest Lua script is atomic, and that
 * the gateway's transactions actually commit — cannot be proven against a mock.
 *
 * When those services are not reachable the setup does not fail the run: it
 * clears `RQ_TEST_DATABASE_URL` / `RQ_TEST_REDIS_URL`, and the integration
 * suites skip themselves with a message. Unit suites never need either.
 *
 * The database is a dedicated `<name>_test` alongside the development one, and
 * it is migrated from `src/db/migrations` on every run, so a schema change is
 * picked up without anyone remembering to reset it.
 */
import { Redis } from 'ioredis';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

const DEFAULT_DATABASE_URL =
  'postgres://redquant_dev:redquant-dev-only-pw@127.0.0.1:5432/redquant';
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

/** Redis logical database reserved for tests, so a dev keyspace is never flushed. */
const TEST_REDIS_DB = 15;

async function probePostgres(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function ensureTestDatabase(baseUrl: string): Promise<string | null> {
  const parsed = new URL(baseUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const testName = `${baseName}_test`;

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({
    connectionString: adminUrl.href,
    connectionTimeoutMillis: 2_000,
  });

  try {
    await admin.connect();
    const existing = await admin.query('select 1 from pg_database where datname = $1', [testName]);
    if (existing.rowCount === 0) {
      // Identifier interpolation: `testName` is derived from a URL path we
      // already parsed, and is quoted, so this is not a user-controlled string.
      await admin.query(`create database "${testName.replace(/"/g, '""')}"`);
    }
  } catch {
    return null;
  } finally {
    await admin.end().catch(() => undefined);
  }

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${testName}`;
  return testUrl.href;
}

async function probeRedis(url: string): Promise<boolean> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export default async function setup(): Promise<void> {
  const baseDatabaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const baseRedisUrl = process.env['REDIS_URL'] ?? DEFAULT_REDIS_URL;

  delete process.env['RQ_TEST_DATABASE_URL'];
  delete process.env['RQ_TEST_REDIS_URL'];

  if (await probePostgres(baseDatabaseUrl)) {
    const testUrl = await ensureTestDatabase(baseDatabaseUrl);
    if (testUrl) {
      try {
        await runMigrations({ connectionString: testUrl });
        process.env['RQ_TEST_DATABASE_URL'] = testUrl;
      } catch (error) {
        process.stderr.write(
          `[global-setup] migrating the test database failed; Postgres suites will skip.\n${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    } else {
      process.stderr.write(
        '[global-setup] could not create the test database; Postgres suites will skip.\n',
      );
    }
  } else {
    process.stderr.write(
      `[global-setup] Postgres is not reachable at ${baseDatabaseUrl}; Postgres suites will skip.\n`,
    );
  }

  const redisUrl = new URL(baseRedisUrl);
  redisUrl.pathname = `/${TEST_REDIS_DB}`;

  if (await probeRedis(redisUrl.href)) {
    process.env['RQ_TEST_REDIS_URL'] = redisUrl.href;
  } else {
    process.stderr.write(
      `[global-setup] Redis is not reachable at ${redisUrl.href}; Redis suites will skip.\n`,
    );
  }
}

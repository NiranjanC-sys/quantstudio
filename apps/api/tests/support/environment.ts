/**
 * Availability of the real dependencies, as decided by `tests/global-setup.ts`.
 *
 * Suites use these with `describe.skipIf(...)`, and the reason string is printed
 * once per suite so a skipped integration run is never mistaken for a passing
 * one.
 */
export const TEST_DATABASE_URL = process.env['RQ_TEST_DATABASE_URL'] ?? null;
export const TEST_REDIS_URL = process.env['RQ_TEST_REDIS_URL'] ?? null;

export const HAS_POSTGRES = TEST_DATABASE_URL !== null;
export const HAS_REDIS = TEST_REDIS_URL !== null;

export function requireRedisUrl(): string {
  if (!TEST_REDIS_URL) throw new Error('Redis is not available for this suite.');
  return TEST_REDIS_URL;
}

export function requireDatabaseUrl(): string {
  if (!TEST_DATABASE_URL) throw new Error('Postgres is not available for this suite.');
  return TEST_DATABASE_URL;
}

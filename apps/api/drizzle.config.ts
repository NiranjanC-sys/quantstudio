import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `pnpm db:generate` diffs `src/db/schema` against the checked-in journal in
 * `src/db/migrations` and emits plain SQL. The partitioning DDL required by
 * system-design §5 (monthly ranges for `labs.submissions` /
 * `contest.submissions`, weekly for `progress.xp_events`) cannot be expressed in
 * the Drizzle DSL, so the generated `CREATE TABLE` statements for those three
 * relations are hand-extended with `PARTITION BY RANGE (...)` and the partition
 * lifecycle lives in `0001_partitions.sql`. See README §Migrations.
 */
export default defineConfig({
  schema: './dist/src/db/schema/index.js',
  out: './src/db/migrations',
  dialect: 'postgresql',
  schemaFilter: ['identity', 'catalog', 'progress', 'labs', 'contest', 'billing', 'social'],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://redquant:redquant@127.0.0.1:5432/redquant',
  },
  strict: true,
  verbose: true,
});

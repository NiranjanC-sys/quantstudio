import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration suites talk to a single shared Postgres/Redis pair brought up by
    // `globalSetup`; running them in one fork keeps schema setup deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
    reporters: ['default'],
  },
});

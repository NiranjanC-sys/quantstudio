import { defineConfig, devices } from '@playwright/test';

/**
 * The suite runs against a production build, not the dev server, because the
 * two differ in ways that have already bitten us: prerendering, hydration and
 * static param generation only behave realistically in `next build`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3211',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npx next build && npx next start -p 3211',
        url: 'http://localhost:3211',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});

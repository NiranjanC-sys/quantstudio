import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility is asserted, not hoped for.
 *
 * Every route a learner can reach is scanned against WCAG 2.1 AA. The scan runs
 * in both themes because our palette is defined twice and a contrast failure
 * can exist in one and not the other.
 */

const ROUTES = [
  { path: '/', name: 'landing' },
  { path: '/curriculum', name: 'curriculum' },
  { path: '/pricing', name: 'pricing' },
  { path: '/roadmaps', name: 'roadmaps' },
  { path: '/contests', name: 'contests' },
  { path: '/interview', name: 'interview bank' },
  { path: '/interview/companies', name: 'employer briefings' },
  { path: '/login', name: 'sign in' },
  { path: '/signup', name: 'sign up' },
  { path: '/lab', name: 'circuit lab' },
  { path: '/learn/t0/m1/l1-bits-and-states', name: 'lesson' },
];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility, ${theme} theme`, () => {
    for (const route of ROUTES) {
      test(`${route.name} has no violations`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(route.path);
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);

        const results = await new AxeBuilder({ page })
          .withTags(TAGS)
          // The WebGL canvas has an aria-label on its wrapper; axe cannot see
          // inside it and reports a false positive on nested interactive roles.
          .exclude('.rq-bloch canvas')
          .analyze();

        const summary = results.violations.map(
          (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) - ${v.help}`,
        );
        expect(summary, summary.join('\n')).toEqual([]);
      });
    }
  });
}

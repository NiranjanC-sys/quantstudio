import { test, expect } from '@playwright/test';

test.describe('site', () => {
  test('the landing page runs the real engine in its hero', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Learn quantum computing');
    // The hero table is computed, not hardcoded: H|0> is 50/50.
    await expect(page.locator('.rq-hero-instrument')).toContainText('50.0%');
    await page.getByRole('tab', { name: 'entangle' }).click();
    await expect(page.locator('.rq-hero-instrument')).toContainText('|11⟩');
  });

  test('the curriculum page reports real authored progress', async ({ page }) => {
    await page.goto('/curriculum');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('curriculum');
    await expect(page.locator('.rq-progress-line')).toContainText('of 306 lessons');
    await expect(page.getByRole('heading', { name: 'Quantum Computing Core' })).toBeVisible();
  });

  test('pricing shows four plans and the feature matrix', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.locator('.rq-plan')).toHaveCount(4);
    await expect(page.locator('.rq-compare')).toContainText('Max qubits, statevector');
  });

  test('the interview bank filters by company', async ({ page }) => {
    await page.goto('/interview');
    const count = page.locator('.rq-iv-count');
    const before = await count.textContent();
    await page.getByRole('button', { name: /^IBM/ }).click();
    await expect(count).not.toHaveText(before ?? '');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(count).toHaveText(before ?? '');
  });

  test('every primary nav destination resolves', async ({ page }) => {
    for (const path of ['/curriculum', '/lab', '/contests', '/interview', '/pricing', '/roadmaps', '/login', '/signup']) {
      const res = await page.goto(path);
      expect(res?.status(), `${path} did not return 200`).toBe(200);
    }
  });

  test('the theme toggle switches data-theme in both directions', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await page.getByRole('button', { name: /^Theme:/ }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: /^Theme:/ }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });
});

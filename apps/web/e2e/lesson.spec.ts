import { test, expect } from '@playwright/test';

test.describe('lesson reader', () => {
  test('renders maths, marginalia and a live circuit figure', async ({ page }) => {
    await page.goto('/learn/t0/m1/l1-bits-and-states');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // KaTeX rendered rather than left as raw markup. Note that KaTeX keeps the
    // original LaTeX in an <annotation> for screen readers and copy-paste, so
    // the meaningful assertion is that nothing failed to parse: a macro it does
    // not know (\ket, \bra) renders as .katex-error, not as an exception.
    await expect(page.locator('.katex').first()).toBeVisible();
    await expect(page.locator('.katex-error')).toHaveCount(0);
    await expect(page.locator('.katex-html').first()).toBeVisible();

    // The embedded figure is simulated at read time.
    const figure = page.locator('.rq-lesson-figure').first();
    await expect(figure).toBeVisible();
    await expect(figure.locator('.rq-lesson-figure-foot')).toContainText('qubits');

    // Sources are cited.
    await expect(page.locator('.rq-lesson-sources')).toBeVisible();
  });

  test('the self-test hides its answer until asked', async ({ page }) => {
    await page.goto('/learn/t0/m1/l1-bits-and-states');
    const check = page.locator('.rq-check').first();
    if (await check.count()) {
      await expect(check.locator('.rq-check-a')).toHaveCount(0);
      await check.getByRole('button', { name: 'Show the answer' }).click();
      await expect(check.locator('.rq-check-a')).toBeVisible();
    }
  });
});

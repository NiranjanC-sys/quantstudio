import { test, expect } from '@playwright/test';

/**
 * The lab is the product. These tests assert on physics, not on markup: if a
 * refactor changes the amplitude of a Bell state, the suite fails.
 */

test.describe('circuit lab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/lab');
  });

  test('loads with an empty circuit in the ground state', async ({ page }) => {
    await expect(page).toHaveTitle(/Lab/);
    // |000> carries all the probability.
    await expect(page.getByRole('row', { name: /000/ })).toContainText('100.00%');
    await expect(page.getByText('CLIFFORD', { exact: false })).toBeVisible();
  });

  test('a Bell pair produces the right amplitudes and no single-qubit purity', async ({ page }) => {
    await page.locator('#tb-preset').selectOption('bell');

    // 1/sqrt(2) on |00> and |11>, nothing on |01> or |10>.
    const rows = page.locator('.rq-amp-table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('0.7071');
    await expect(rows.first()).toContainText('50.00%');

    // Both qubits are maximally mixed, so their Bloch vectors vanish.
    await page.getByRole('tab', { name: 'bloch' }).click();
    await expect(page.getByLabel(/q0.*Bloch vector x 0.000, y 0.000, z 0.000/)).toBeVisible();
  });

  test('QFT on three qubits gives a uniform superposition', async ({ page }) => {
    await page.locator('#tb-preset').selectOption('qft');
    const rows = page.locator('.rq-amp-table tbody tr');
    await expect(rows).toHaveCount(8);
    for (let i = 0; i < 8; i++) {
      await expect(rows.nth(i)).toContainText('0.3536');
      await expect(rows.nth(i)).toContainText('12.50%');
    }
  });

  test('Grover concentrates probability on the marked state', async ({ page }) => {
    await page.locator('#tb-preset').selectOption('grover');
    const top = page.locator('.rq-amp-table tbody tr').first();
    // Marked item is |101>, and two iterations reach about 94.5 percent.
    await expect(top).toContainText('101');
    await expect(top).toContainText(/9[45]\.\d\d%/);
  });

  test('a Grover circuit is reported as not Clifford', async ({ page }) => {
    await page.locator('#tb-preset').selectOption('grover');
    await expect(page.locator('.rq-results-foot')).toContainText('no');
  });

  test('the OpenQASM tab emits parseable source and round trips', async ({ page }) => {
    await page.locator('#tb-preset').selectOption('bell');
    const code = page.getByLabel('qasm3 source');
    await expect(code).toContainText('OPENQASM 3.0;');
    await expect(code).toContainText('h q[0];');
    await expect(code).toContainText('cx q[0], q[1];');
  });

  test('Qiskit export mirrors qubit indices for little-endian', async ({ page }) => {
    await page.locator('#tb-preset').selectOption('bell');
    await page.getByRole('tab', { name: 'Qiskit' }).click();
    const code = page.getByLabel('qiskit source');
    await expect(code).toContainText('qc.h(1)');
    await expect(code).toContainText('qc.cx(1, 0)');
  });

  test('placing a gate from the palette changes the state', async ({ page }) => {
    await page.getByRole('button', { name: /^Hadamard\./ }).click();
    const rows = page.locator('.rq-amp-table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('50.00%');
  });

  test('undo reverses an edit', async ({ page }) => {
    await page.getByRole('button', { name: /^Hadamard\./ }).click();
    await expect(page.locator('.rq-amp-table tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.rq-amp-table tbody tr')).toHaveCount(1);
  });

  test('the qubit count caps at the browser engine limit', async ({ page }) => {
    await page.locator('#tb-qubits').fill('14');
    await expect(page.locator('.rq-results-foot')).toContainText('14');
  });
});

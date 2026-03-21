import { test, expect } from '@playwright/test';
import { MavDeckPage } from './helpers';

test.describe('Parameters', () => {
  let mavdeck: MavDeckPage;

  test.beforeEach(async ({ page }) => {
    mavdeck = new MavDeckPage(page);
    await mavdeck.goto();
    await mavdeck.startSimulator();
    // Let data flow stabilize before switching tabs
    await mavdeck.waitForMessages();
    await mavdeck.switchTab('Parameters');
  });

  test('read parameters populates the list', async () => {
    // Click the Read button
    await mavdeck.page.getByRole('button', { name: 'Read', exact: true }).click();

    // Wait for parameter groups to appear (spoof responder returns 39 params)
    // Parameter groups use data-testid="param-group-{name}"
    await expect(mavdeck.page.locator('[data-testid^="param-group-"]').first()).toBeVisible({ timeout: 15_000 });

    // Should have multiple groups
    const groupCount = await mavdeck.page.locator('[data-testid^="param-group-"]').count();
    expect(groupCount).toBeGreaterThan(0);
  });

  test('search filters parameters', async () => {
    // Read params first
    await mavdeck.page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(mavdeck.page.locator('[data-testid^="param-group-"]').first()).toBeVisible({ timeout: 15_000 });

    const totalGroups = await mavdeck.page.locator('[data-testid^="param-group-"]').count();

    // Type in search box
    await mavdeck.page.getByPlaceholder('Search...').fill('JS');

    // Wait for filter to apply
    const filteredGroups = await mavdeck.page.locator('[data-testid^="param-group-"]').count();
    expect(filteredGroups).toBeLessThan(totalGroups);
    expect(filteredGroups).toBeGreaterThan(0);
  });

  test('select and set a parameter value', async () => {
    // Read params
    await mavdeck.page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(mavdeck.page.locator('[data-testid^="param-group-"]').first()).toBeVisible({ timeout: 15_000 });

    // Expand first group and click a parameter
    await mavdeck.page.locator('[data-testid^="param-group-"]').first().locator('button').first().click();

    // Click the first parameter row within the expanded group
    const paramRow = mavdeck.page.locator('[data-testid^="param-group-"]').first().locator('button').nth(1);
    await paramRow.click();

    // Detail panel should show (right side) — look for an input field
    const valueInput = mavdeck.page.locator('input[type="number"], input[type="text"]').last();
    await expect(valueInput).toBeVisible({ timeout: 3_000 });

    // Modify the value
    await valueInput.fill('0.5');
    await valueInput.press('Enter');

    // Look for the save/send feedback — the spoof responder ACKs immediately
    // The parameter detail panel shows a confirmation flash or updated value
    // Wait briefly for the ACK round-trip
    await mavdeck.page.waitForTimeout(1000);

    // Verify no error states appeared
    const errors = mavdeck.page.locator('[data-testid="param-set-error"]');
    await expect(errors).toHaveCount(0);
  });
});

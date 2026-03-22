import { test, expect } from '@playwright/test';
import { MavDeckPage } from './helpers';

test.describe('Plot Creation and Signals', () => {
  let mavdeck: MavDeckPage;

  test.beforeEach(async ({ page }) => {
    mavdeck = new MavDeckPage(page);
    await mavdeck.goto();
    await mavdeck.startSimulator();
    await mavdeck.waitForMessages();
  });

  test('add a new empty plot', async () => {
    await mavdeck.addPlot();

    await expect(mavdeck.page.locator('.grid-stack-item')).toHaveCount(1);
    await expect(mavdeck.page.getByText('No signals')).toBeVisible();
  });

  test('open signal selector via double-click on plot header', async () => {
    await mavdeck.addPlot();

    // The plot header has cursor-grab styling (the drag handle)
    const plotHeader = mavdeck.page.locator('.grid-stack-item .cursor-grab').first();
    await plotHeader.dblclick();

    await expect(mavdeck.page.getByText('Select Signals')).toBeVisible();
  });

  test('add signals to a plot and verify chart renders', async () => {
    await mavdeck.addPlot();

    // Open signal selector
    const plotHeader = mavdeck.page.locator('.grid-stack-item .cursor-grab').first();
    await plotHeader.dblclick();
    await expect(mavdeck.page.getByText('Select Signals')).toBeVisible();

    // Expand ATTITUDE group and add roll
    await mavdeck.page.getByTestId('signal-group-ATTITUDE').click();
    await mavdeck.page.getByText('roll', { exact: true }).click();

    // Close signal selector
    await mavdeck.page.getByLabel('Close signal selector').click();

    // Plot should show signal (not "No signals") and render a canvas
    await expect(mavdeck.page.getByText('No signals')).not.toBeVisible();
    await expect(mavdeck.page.locator('.grid-stack-item canvas')).toBeVisible({ timeout: 5_000 });
  });

  test('clear all signals from a plot', async () => {
    await mavdeck.addPlot();

    // Add a signal first
    const plotHeader = mavdeck.page.locator('.grid-stack-item .cursor-grab').first();
    await plotHeader.dblclick();
    await mavdeck.page.getByTestId('signal-group-ATTITUDE').click();
    await mavdeck.page.getByText('roll', { exact: true }).click();
    await mavdeck.page.getByLabel('Close signal selector').click();

    // Click the plot to select it, then clear
    await mavdeck.page.locator('.grid-stack-item').first().click();
    await mavdeck.page.getByLabel('Clear all signals').click();

    await expect(mavdeck.page.getByText('No signals')).toBeVisible();
  });

  test('remove a plot panel', async () => {
    await mavdeck.addPlot();
    await expect(mavdeck.page.locator('.grid-stack-item')).toHaveCount(1);

    // Select then remove
    await mavdeck.page.locator('.grid-stack-item').first().click();
    await mavdeck.page.getByLabel('Remove plot').click();

    await expect(mavdeck.page.locator('.grid-stack-item')).toHaveCount(0);
  });
});

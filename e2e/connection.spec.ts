import { test, expect } from '@playwright/test';
import { MavDeckPage } from './helpers';

test.describe('Connection Lifecycle', () => {
  let mavdeck: MavDeckPage;

  test.beforeEach(async ({ page }) => {
    mavdeck = new MavDeckPage(page);
    await mavdeck.goto();
  });

  test('app loads with disconnected status', async () => {
    await expect(mavdeck.page.locator('[title="disconnected"]')).toBeVisible();
  });

  test('start simulator transitions to connected', async () => {
    await mavdeck.startSimulator();

    await expect(mavdeck.page.locator('[title="connected"]')).toBeVisible();
    await expect(mavdeck.page.getByLabel('Pause')).toBeVisible();
  });

  test('stop simulator transitions back to disconnected', async () => {
    await mavdeck.startSimulator();
    await mavdeck.stopSimulator();

    await expect(mavdeck.page.locator('[title="disconnected"]')).toBeVisible();
  });

  test('pause and resume telemetry', async () => {
    await mavdeck.startSimulator();

    await mavdeck.page.getByLabel('Pause').click();
    await expect(mavdeck.page.getByLabel('Resume')).toBeVisible();

    await mavdeck.page.getByLabel('Resume').click();
    await expect(mavdeck.page.getByLabel('Pause')).toBeVisible();
  });
});

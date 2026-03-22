import { test, expect } from '@playwright/test';
import { MavDeckPage } from './helpers';

test.describe('Telemetry Display', () => {
  let mavdeck: MavDeckPage;

  test.beforeEach(async ({ page }) => {
    mavdeck = new MavDeckPage(page);
    await mavdeck.goto();
    await mavdeck.startSimulator();
    await mavdeck.waitForMessages();
  });

  test('message monitor shows expected MAVLink messages', async () => {
    await expect(mavdeck.page.getByTestId('msg-HEARTBEAT')).toBeVisible();
    await expect(mavdeck.page.getByTestId('msg-ATTITUDE')).toBeVisible();
    await expect(mavdeck.page.getByTestId('msg-VFR_HUD')).toBeVisible();
    await expect(mavdeck.page.getByTestId('msg-SYS_STATUS')).toBeVisible();
  });

  test('expanding a message shows its fields', async () => {
    // Click the ATTITUDE message row to expand it
    await mavdeck.page.getByTestId('msg-ATTITUDE').locator('button').first().click();

    // Field names should be visible (exact match to avoid e.g. "roll" matching "rollspeed")
    await expect(mavdeck.page.getByTestId('msg-ATTITUDE').getByText('roll', { exact: true })).toBeVisible({ timeout: 3_000 });
    await expect(mavdeck.page.getByTestId('msg-ATTITUDE').getByText('pitch', { exact: true })).toBeVisible();
    await expect(mavdeck.page.getByTestId('msg-ATTITUDE').getByText('yaw', { exact: true })).toBeVisible();
  });

  test('frequency badges appear with Hz values', async () => {
    // Wait for frequency calculation to stabilize (~3s with the rolling window)
    await expect(mavdeck.page.getByTestId('msg-HEARTBEAT').getByText('Hz')).toBeVisible({ timeout: 5_000 });
    await expect(mavdeck.page.getByTestId('msg-ATTITUDE').getByText('Hz')).toBeVisible();
  });
});

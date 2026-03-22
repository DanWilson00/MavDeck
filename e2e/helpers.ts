import { expect, type Page } from '@playwright/test';

/**
 * Page object for MavDeck E2E tests.
 *
 * Provides reusable helpers for navigating the app, starting the
 * spoof simulator, and waiting for data flow conditions.
 */
export class MavDeckPage {
  constructor(public readonly page: Page) {}

  /** Navigate to the app, disable auto-connect, and wait for it to be fully initialized. */
  async goto() {
    await this.page.goto('/');
    // The status bar footer appears once the app is ready (dialect loaded, services wired)
    await this.page.locator('footer').waitFor({ state: 'visible', timeout: 15_000 });

    // Disable auto-connect so tests start from a clean "disconnected" state
    await this.page.getByLabel('Open settings').click();
    await this.page.getByRole('tab', { name: 'Serial' }).click();
    const toggle = this.page.getByRole('switch', { name: 'Auto-connect serial' });
    if (await toggle.getAttribute('aria-checked') === 'true') {
      await toggle.click();
    }
    await this.page.getByLabel('Close settings').click();
    await expect(this.page.locator('[title="disconnected"]')).toBeVisible({ timeout: 10_000 });
  }

  /** Open Settings → Advanced → click "Start Simulator" → close → wait for connected. */
  async startSimulator() {
    await this.page.getByLabel('Open settings').click();
    await this.page.getByRole('tab', { name: 'Advanced' }).click();
    await this.page.getByRole('button', { name: 'Start Simulator' }).click();
    await this.page.getByLabel('Close settings').click();
    await expect(this.page.locator('[title="connected"]')).toBeVisible({ timeout: 10_000 });
  }

  /** Open Settings → Advanced → click "Stop Simulator" → close → wait for disconnected. */
  async stopSimulator() {
    await this.page.getByLabel('Open settings').click();
    await this.page.getByRole('tab', { name: 'Advanced' }).click();
    await this.page.getByRole('button', { name: 'Stop Simulator' }).click();
    await this.page.getByLabel('Close settings').click();
    await expect(this.page.locator('[title="disconnected"]')).toBeVisible({ timeout: 10_000 });
  }

  /** Switch to a top-level tab (Telemetry, Map, or Parameters). */
  async switchTab(tab: 'Telemetry' | 'Map' | 'Parameters') {
    await this.page.getByRole('button', { name: tab, exact: true }).click();
  }

  /** Wait until the message monitor shows at least one message type. */
  async waitForMessages(timeout = 5_000) {
    await expect(this.page.getByText('No telemetry yet.')).not.toBeVisible({ timeout });
  }

  /** Click the "Add plot" button on the toolbar. */
  async addPlot() {
    await this.page.getByLabel('Add plot').click();
  }
}

import { test, expect } from '@playwright/test';

test.describe('Terminal Reconnect & Mode Reset Regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should dispatch mode-reset escape sequences upon reconnection', async ({ page }) => {
    // Evaluate in browser context to test connectionManager reconnect behavior directly
    const resetEvents = await page.evaluate(async () => {
      const { getOrCreateConnection, reconnectConnection, subscribe } = await import(
        '/src/lib/connectionManager.svelte.ts'
      );

      const receivedData: string[] = [];
      const termId = 'test-reconnect-term-1';

      // 1. Create a dummy connection
      getOrCreateConnection(termId, 'ws://127.0.0.1:9999/ws');

      // 2. Subscribe a callback (mimicking xterm.js term.write)
      subscribe(termId, (data) => {
        const text =
          typeof data === 'string' ? data : new TextDecoder().decode(data);
        receivedData.push(text);
      });

      // 3. Trigger reconnect
      reconnectConnection(termId, 'ws://127.0.0.1:9999/ws');

      return receivedData;
    });

    // Verify mode-reset escape sequences were sent to subscribers
    expect(resetEvents.length).toBeGreaterThan(0);
    const combinedReset = resetEvents.join('');

    // Must disable normal, button, any mouse tracking and SGR mode
    expect(combinedReset).toContain('\x1b[?1000l'); // Disable normal mouse tracking
    expect(combinedReset).toContain('\x1b[?1002l'); // Disable button-event mouse tracking
    expect(combinedReset).toContain('\x1b[?1003l'); // Disable any-event mouse tracking
    expect(combinedReset).toContain('\x1b[?1006l'); // Disable SGR mouse mode
    expect(combinedReset).toContain('\x1b[?2004l'); // Disable bracketed paste mode
  });

  test('should trigger reconnect via UI reconnect button without throwing errors', async ({ page }) => {
    // Check if terminal container is present on the page
    const body = page.locator('body');
    await expect(body).toBeVisible();

    // Look for reconnect button title or aria-label
    const reconnectBtn = page.locator('button[title="Reconnect"], button[aria-label="Reconnect"]').first();
    
    // If a terminal is visible with a reconnect button, test clicking it
    if (await reconnectBtn.isVisible()) {
      await reconnectBtn.click();
      // Ensure page remains responsive and intact
      await expect(body).toBeVisible();
    }
  });
});

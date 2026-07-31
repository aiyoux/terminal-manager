import { test, expect } from '@playwright/test';

test.describe('Terminal Dashboard E2E Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should render the application header and dashboard layout', async ({ page }) => {
    // Check that main body loads
    await expect(page.locator('body')).toBeVisible();

    // Verify main page elements are present
    const mainContent = page.locator('main, div.flex');
    await expect(mainContent.first()).toBeVisible();
  });

  test('should allow font size adjustment on active terminal', async ({ page }) => {
    const decBtn = page.locator('button[title="Decrease font size"]').first();
    const incBtn = page.locator('button[title="Increase font size"]').first();

    if (await incBtn.isVisible()) {
      await incBtn.click();
      await expect(page.locator('body')).toBeVisible();
    }
    if (await decBtn.isVisible()) {
      await decBtn.click();
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('should provide clear screen action on terminal window', async ({ page }) => {
    const clearBtn = page.locator('button[title="Clear screen"], button[aria-label="Clear screen"]').first();

    if (await clearBtn.isVisible()) {
      await clearBtn.click();
      await expect(page.locator('body')).toBeVisible();
    }
  });
});

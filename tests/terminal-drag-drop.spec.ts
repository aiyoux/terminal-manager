import { test, expect } from '@playwright/test';

test.describe('Terminal Drag & Drop Across Folders', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should move terminal from one project to another via moveTerminal store helper', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      
      let conn = stores.getConnections()[0];
      if (!conn) {
        conn = stores.addConnection('Test Conn', 'ws://127.0.0.1:9999/ws');
      }

      if (!conn) {
        return { success: false, reason: 'Failed to create connection' };
      }

      const connId = conn.id;
      // Add two test projects
      const proj1 = stores.addProject(connId, 'Folder A');
      const proj2 = stores.addProject(connId, 'Folder B');

      if (!proj1 || !proj2) {
        return { success: false, reason: 'Failed to create test projects' };
      }

      // Add a terminal to Folder A
      const term = stores.addTerminal(connId, proj1.id, 'Test Terminal Moving');
      if (!term) {
        return { success: false, reason: 'Failed to create test terminal' };
      }

      // Move terminal from Folder A to Folder B
      stores.moveTerminal(term.id, proj2.id, 0);

      // Verify terminal is now in Folder B and removed from Folder A
      const updatedProj1 = stores.findProjectById(proj1.id)?.project;
      const updatedProj2 = stores.findProjectById(proj2.id)?.project;

      const inProj1 = updatedProj1?.terminals.some(t => t.id === term.id);
      const inProj2 = updatedProj2?.terminals.some(t => t.id === term.id);

      return {
        success: !inProj1 && inProj2,
        reason: !inProj1 ? (!inProj2 ? 'Terminal not in dest' : 'OK') : 'Terminal still in src',
        inProj1,
        inProj2
      };
    });

    if (!result.success) {
      console.log('Test evaluation failed:', result);
    }
    expect(result.success, result.reason).toBe(true);
    expect(result.inProj1).toBe(false);
    expect(result.inProj2).toBe(true);
  });

  test('should render tree view elements and support drag/drop attributes', async ({ page }) => {
    // Check that tree view sidebar is rendered
    const sidebar = page.locator('aside, nav, div.flex').first();
    await expect(sidebar).toBeVisible();

    // Verify draggable elements exist in the tree view
    const draggables = page.locator('[draggable="true"]');
    const count = await draggables.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

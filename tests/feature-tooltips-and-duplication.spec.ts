import { test, expect } from '@playwright/test';

test.describe('Tooltips, Duplication, and Command Drag-and-Drop E2E Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should render custom data-tooltip attributes on UI elements', async ({ page }) => {
    await expect(page.locator('body')).toBeVisible();

    // Check for data-tooltip elements on action buttons
    const tooltips = page.locator('[data-tooltip]');
    const count = await tooltips.count();
    expect(count).toBeGreaterThan(0);

    // Verify positioning attributes exist
    const tooltipPos = page.locator('[data-tooltip-pos]');
    const posCount = await tooltipPos.count();
    expect(posCount).toBeGreaterThan(0);
  });

  test('should duplicate terminal configuration and saved commands via store helper', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');

      let conn = stores.getConnections()[0];
      if (!conn) {
        conn = stores.addConnection('Test Conn', 'ws://127.0.0.1:9999/ws');
      }
      if (!conn) return { success: false, reason: 'No connection' };

      let proj = conn.projects[0];
      if (!proj) {
        proj = stores.addProject(conn.id, 'Test Project');
      }
      if (!proj) return { success: false, reason: 'No project' };

      const term = stores.addTerminal(conn.id, proj.id, 'Source Terminal');
      if (!term) return { success: false, reason: 'No terminal' };

      // Add a command to source terminal
      const srcCmd = stores.addSavedCommand(conn.id, proj.id, term.id, 'Test Cmd', 'echo hello', true, false, false);
      if (!srcCmd) return { success: false, reason: 'No command' };

      // Duplicate terminal
      const dup = stores.duplicateTerminal(conn.id, proj.id, term.id);
      if (!dup) return { success: false, reason: 'Failed to duplicate terminal' };

      const isCopyName = dup.name === 'Source Terminal (Copy)';
      const hasCopiedCmd = dup.savedCommands.some(c => c.command === 'echo hello');
      // Deep copy must mint new command IDs so DND/highlights are not tied together
      const idsIndependent = dup.savedCommands.every(c => c.id !== srcCmd.id);
      const sameLabel = dup.savedCommands.some(c => c.label === 'Test Cmd');

      // Mutating the copy must not affect the source
      const dupCmd = dup.savedCommands[0];
      stores.updateSavedCommand(conn.id, proj.id, dup.id, dupCmd.id, 'Changed on copy', 'echo copy', true, false);
      const sourceAfter = stores.findTerminalById(term.id)?.terminal;
      const sourceStillOriginal = sourceAfter?.savedCommands.some(
        c => c.id === srcCmd.id && c.label === 'Test Cmd' && c.command === 'echo hello'
      );
      const copyUpdated = stores.findTerminalById(dup.id)?.terminal?.savedCommands.some(
        c => c.id === dupCmd.id && c.label === 'Changed on copy'
      );

      return {
        success: isCopyName && hasCopiedCmd && idsIndependent && sameLabel && !!sourceStillOriginal && !!copyUpdated,
        dupName: dup.name,
        cmdCount: dup.savedCommands.length,
        idsIndependent,
        sourceStillOriginal: !!sourceStillOriginal,
        copyUpdated: !!copyUpdated,
      };
    });

    expect(result.success).toBe(true);
    expect(result.dupName).toBe('Source Terminal (Copy)');
    expect(result.cmdCount).toBeGreaterThan(0);
    expect(result.idsIndependent).toBe(true);
    expect(result.sourceStillOriginal).toBe(true);
    expect(result.copyUpdated).toBe(true);
  });

  test('should duplicate saved command shortcut via store helper', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');

      let conn = stores.getConnections()[0];
      if (!conn) conn = stores.addConnection('Test Conn 2', 'ws://127.0.0.1:9999/ws');
      if (!conn) return { success: false };

      let proj = conn.projects[0];
      if (!proj) proj = stores.addProject(conn.id, 'Project 2');
      if (!proj) return { success: false };

      const term = stores.addTerminal(conn.id, proj.id, 'Terminal 2');
      if (!term) return { success: false };

      const cmd = stores.addSavedCommand(conn.id, proj.id, term.id, 'Build App', 'npm run build', false, true, false);
      if (!cmd) return { success: false };

      const dupCmd = stores.duplicateSavedCommand(conn.id, proj.id, term.id, cmd.id);
      if (!dupCmd) return { success: false };

      const updatedTerm = stores.findTerminalById(term.id)?.terminal;
      const count = updatedTerm?.savedCommands.length || 0;

      return {
        success: dupCmd.label === 'Build App (Copy)' && count === 2,
        dupLabel: dupCmd.label,
        count
      };
    });

    expect(result.success).toBe(true);
    expect(result.dupLabel).toBe('Build App (Copy)');
    expect(result.count).toBe(2);
  });

  test('should move saved command shortcut from one terminal to another via drag and drop store helper', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');

      let conn = stores.getConnections()[0];
      if (!conn) conn = stores.addConnection('Test Conn 3', 'ws://127.0.0.1:9999/ws');
      if (!conn) return { success: false };

      let proj = conn.projects[0];
      if (!proj) proj = stores.addProject(conn.id, 'Project 3');
      if (!proj) return { success: false };

      const termA = stores.addTerminal(conn.id, proj.id, 'Terminal Alpha');
      const termB = stores.addTerminal(conn.id, proj.id, 'Terminal Beta');
      if (!termA || !termB) return { success: false };

      const cmd = stores.addSavedCommand(conn.id, proj.id, termA.id, 'Deploy', 'wrangler deploy', true, false, false);
      if (!cmd) return { success: false };

      // Move command from Alpha to Beta
      stores.moveSavedCommand(termA.id, termB.id, cmd.id, 0);

      const updatedA = stores.findTerminalById(termA.id)?.terminal;
      const updatedB = stores.findTerminalById(termB.id)?.terminal;

      const inA = updatedA?.savedCommands.some(c => c.id === cmd.id);
      const inB = updatedB?.savedCommands.some(c => c.id === cmd.id);

      return {
        success: !inA && inB,
        inA,
        inB
      };
    });

    expect(result.success).toBe(true);
    expect(result.inA).toBe(false);
    expect(result.inB).toBe(true);
  });
});

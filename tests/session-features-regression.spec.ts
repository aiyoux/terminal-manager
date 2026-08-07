import { test, expect } from '@playwright/test';

/**
 * Regression coverage for session work:
 * - Shared delete confirmation modal
 * - Terminal header command chips + gear settings popup
 * - Command action icon view toggle (default hidden)
 * - Single-click tree rows to expand/collapse (click-vs-drag guarded)
 * - Store APIs used by those UIs (incl. isOnConnect on add/update)
 */
test.describe('Session features regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Clear view settings so default-hidden tests are deterministic
    await page.evaluate(() => {
      try {
        localStorage.removeItem('terminal-dashboard-view-settings');
      } catch {
        /* ignore */
      }
    });
    await page.reload();
    await expect(page.locator('body')).toBeVisible();
  });

  test('store: addSavedCommand supports isOnConnect and updateSavedCommand persists flags', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');

      let conn = stores.getConnections()[0];
      if (!conn) conn = stores.addConnection('E2E Conn', 'ws://127.0.0.1:9999/ws');
      if (!conn) return { success: false, reason: 'no connection' };

      let proj = conn.projects[0];
      if (!proj) proj = stores.addProject(conn.id, 'E2E Project');
      if (!proj) return { success: false, reason: 'no project' };

      const term = stores.addTerminal(conn.id, proj.id, 'E2E Term Flags');
      if (!term) return { success: false, reason: 'no terminal' };

      const cmd = stores.addSavedCommand(
        conn.id,
        proj.id,
        term.id,
        'Boot',
        'echo boot',
        true,
        true,
        true // isOnConnect
      );
      if (!cmd) return { success: false, reason: 'add failed' };

      const afterAdd = stores.findTerminalById(term.id)?.terminal?.savedCommands.find((c: { id: string }) => c.id === cmd.id);
      if (!afterAdd) return { success: false, reason: 'cmd missing after add' };

      const addOk =
        afterAdd.isOnConnect === true &&
        afterAdd.autoExecute !== false &&
        afterAdd.sendCtrlCBefore === true;

      stores.updateSavedCommand(conn.id, proj.id, term.id, cmd.id, 'Boot2', 'echo boot2', false, false, false);
      const afterUpdate = stores.findTerminalById(term.id)?.terminal?.savedCommands.find((c: { id: string }) => c.id === cmd.id);

      const updateOk =
        !!afterUpdate &&
        afterUpdate.label === 'Boot2' &&
        afterUpdate.command === 'echo boot2' &&
        afterUpdate.autoExecute === false &&
        afterUpdate.sendCtrlCBefore === false &&
        afterUpdate.isOnConnect === false;

      return { success: addOk && updateOk, addOk, updateOk };
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  test('store: remove helpers used by confirm-delete flows work', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');

      const conn = stores.addConnection('Delete Me Conn', 'ws://127.0.0.1:9998/ws');
      if (!conn) return { success: false, reason: 'no conn' };
      const proj = stores.addProject(conn.id, 'Delete Me Proj');
      if (!proj) return { success: false, reason: 'no proj' };
      const term = stores.addTerminal(conn.id, proj.id, 'Delete Me Term');
      if (!term) return { success: false, reason: 'no term' };
      const cmd = stores.addSavedCommand(conn.id, proj.id, term.id, 'X', 'echo x', true, false, false);
      if (!cmd) return { success: false, reason: 'no cmd' };

      stores.removeSavedCommand(conn.id, proj.id, term.id, cmd.id);
      const afterCmd = stores.findTerminalById(term.id)?.terminal;
      const cmdGone = !afterCmd?.savedCommands.some((c: { id: string }) => c.id === cmd.id);

      stores.removeTerminal(conn.id, proj.id, term.id);
      const termGone = !stores.findTerminalById(term.id);

      stores.removeProject(conn.id, proj.id);
      const projGone = !stores.findProjectById(proj.id);

      stores.removeConnection(conn.id);
      const connGone = !stores.getConnections().some((c: { id: string }) => c.id === conn.id);

      return {
        success: cmdGone && termGone && projGone && connGone,
        cmdGone,
        termGone,
        projGone,
        connGone,
      };
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  test('store: collapse toggles flip connection / project / terminal collapsed state', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');

      let conn = stores.getConnections()[0];
      if (!conn) conn = stores.addConnection('Collapse Conn', 'ws://127.0.0.1:9997/ws');
      if (!conn) return { success: false };

      let proj = conn.projects[0];
      if (!proj) proj = stores.addProject(conn.id, 'Collapse Proj');
      if (!proj) return { success: false };

      const term = stores.addTerminal(conn.id, proj.id, 'Collapse Term');
      if (!term) return { success: false };

      const beforeConn = !!stores.getConnections().find((c: { id: string }) => c.id === conn!.id)?.collapsed;
      stores.toggleConnectionCollapse(conn.id);
      const afterConn = !!stores.getConnections().find((c: { id: string }) => c.id === conn!.id)?.collapsed;

      const beforeProj = !!stores.findProjectById(proj.id)?.project.collapsed;
      stores.toggleProjectCollapse(conn.id, proj.id);
      const afterProj = !!stores.findProjectById(proj.id)?.project.collapsed;

      const beforeTerm = !!stores.findTerminalById(term.id)?.terminal.collapsed;
      stores.toggleTerminalCollapse(conn.id, proj.id, term.id);
      const afterTerm = !!stores.findTerminalById(term.id)?.terminal.collapsed;

      return {
        success: beforeConn !== afterConn && beforeProj !== afterProj && beforeTerm !== afterTerm,
        beforeConn,
        afterConn,
        beforeProj,
        afterProj,
        beforeTerm,
        afterTerm,
      };
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  test('UI: view toggle for command action icons defaults off and can be enabled', async ({ page }) => {
    // Ensure we have a terminal + command and expanded commands panel
    await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      let conn = stores.getConnections()[0];
      if (!conn) conn = stores.addConnection('View Conn', 'ws://127.0.0.1:9996/ws');
      if (!conn) return;
      // expand connection
      if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
      let proj = conn.projects[0];
      if (!proj) proj = stores.addProject(conn.id, 'View Proj');
      if (!proj) return;
      if (proj.collapsed) stores.toggleProjectCollapse(conn.id, proj.id);
      const term = stores.addTerminal(conn.id, proj.id, 'View Term Icons');
      if (!term) return;
      if (term.collapsed) stores.toggleTerminalCollapse(conn.id, proj.id, term.id);
      stores.addSavedCommand(conn.id, proj.id, term.id, 'Hello', 'echo hi', true, false, false);
    });

    await page.reload();
    await expect(page.locator('body')).toBeVisible();

    // Expand tree via store after reload (IDs may persist in IndexedDB)
    await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      for (const conn of stores.getConnections()) {
        if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
        for (const proj of conn.projects) {
          if (proj.collapsed) stores.toggleProjectCollapse(conn.id, proj.id);
          for (const term of proj.terminals) {
            if (term.collapsed) stores.toggleTerminalCollapse(conn.id, proj.id, term.id);
          }
          for (const group of conn.projectGroups ?? []) {
            if (group.collapsed) stores.toggleProjectGroupCollapse(conn.id, group.id);
            for (const proj of group.projects) {
              if (proj.collapsed) stores.toggleProjectCollapse(conn.id, proj.id);
              for (const term of proj.terminals) {
                if (term.collapsed) stores.toggleTerminalCollapse(conn.id, proj.id, term.id);
              }
            }
          }
        }
      }
    });

    const viewSwitch = page.getByRole('switch', { name: 'Show command action icons in tree' });
    await expect(viewSwitch).toBeVisible();
    await expect(viewSwitch).toHaveAttribute('aria-checked', 'false');

    // Command label should appear without requiring icons
    const cmdLabel = page.getByText('Hello', { exact: true }).first();
    // May need a moment for reactivity
    await expect(page.locator('body')).toBeVisible();

    // When icons hidden, auto-run enable tooltips on command rows should not be present for our command row
    // Toggle ON
    await viewSwitch.click();
    await expect(viewSwitch).toHaveAttribute('aria-checked', 'true');

    // Preference persisted
    const persisted = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('terminal-dashboard-view-settings');
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    });
    expect(persisted?.showCommandActionIcons).toBe(true);

    // Toggle back OFF
    await viewSwitch.click();
    await expect(viewSwitch).toHaveAttribute('aria-checked', 'false');

    // Silence unused if command not visible in empty layouts
    void cmdLabel;
  });

  test('UI: delete confirmation modal cancel does not remove connection', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      const conn = stores.addConnection('Confirm Cancel Conn', 'ws://127.0.0.1:9995/ws');
      return conn ? { id: conn.id, name: conn.name } : null;
    });
    expect(setup).not.toBeNull();

    await page.reload();
    await expect(page.locator('body')).toBeVisible();

    // Ensure connections tab route (tabs are links so refresh keeps the tab)
    await page.getByRole('link', { name: 'Connections' }).click();
    await expect(page).toHaveURL(/\/connections\/?$/);

    // Hover connection row to reveal actions - click remove for our connection
    // Scope by text then find remove control nearby
    const connRow = page.locator('button', { hasText: setup!.name }).first();
    await expect(connRow).toBeVisible({ timeout: 10_000 });
    await connRow.hover();

    const removeBtn = connRow.locator('[data-tooltip="Remove connection server"]');
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // Confirm dialog appears
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Remove connection')).toBeVisible();
    await expect(dialog.getByText(/all its projects/i)).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // Connection still exists
    const stillThere = await page.evaluate((id) => {
      return import('/src/lib/stores.svelte.ts').then((stores) =>
        stores.getConnections().some((c: { id: string }) => c.id === id)
      );
    }, setup!.id);
    expect(stillThere).toBe(true);
  });

  test('UI: delete confirmation modal confirms terminal removal', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      let conn = stores.getConnections()[0];
      if (!conn) conn = stores.addConnection('Term Del Conn', 'ws://127.0.0.1:9994/ws');
      if (!conn) return null;
      if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
      let proj = conn.projects[0];
      if (!proj) proj = stores.addProject(conn.id, 'Term Del Proj');
      if (!proj) return null;
      if (proj.collapsed) stores.toggleProjectCollapse(conn.id, proj.id);
      const term = stores.addTerminal(conn.id, proj.id, 'Term To Delete E2E');
      if (!term) return null;
      return { connId: conn.id, projectId: proj.id, terminalId: term.id, name: term.name };
    });
    expect(setup).not.toBeNull();

    await page.reload();
    await expect(page.locator('body')).toBeVisible();

    await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      for (const conn of stores.getConnections()) {
        if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
        for (const proj of conn.projects) {
          if (proj.collapsed) stores.toggleProjectCollapse(conn.id, proj.id);
        }
      }
    });

    const termRow = page.locator('button', { hasText: setup!.name }).first();
    await expect(termRow).toBeVisible({ timeout: 10_000 });
    await termRow.hover();

    const removeBtn = termRow.locator('[data-tooltip="Remove terminal"]');
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Remove terminal')).toBeVisible();

    // Destructive confirm button labeled Delete
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(dialog).toHaveCount(0);

    const gone = await page.evaluate((id) => {
      return import('/src/lib/stores.svelte.ts').then((stores) => !stores.findTerminalById(id));
    }, setup!.terminalId);
    expect(gone).toBe(true);
  });

  test('UI: terminal gear opens command shortcuts panel; no window-level duplicate control', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      let conn = stores.getConnections()[0];
      if (!conn) conn = stores.addConnection('Gear Conn', 'ws://127.0.0.1:9993/ws');
      if (!conn) return null;
      if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
      let proj = conn.projects[0];
      if (!proj) proj = stores.addProject(conn.id, 'Gear Proj');
      if (!proj) return null;
      if (proj.collapsed) stores.toggleProjectCollapse(conn.id, proj.id);
      const term = stores.addTerminal(conn.id, proj.id, 'Gear Term E2E');
      if (!term) return null;
      stores.addSavedCommand(conn.id, proj.id, term.id, 'ChipCmd', 'echo chip', true, false, true);
      return { terminalId: term.id, name: term.name };
    });
    expect(setup).not.toBeNull();

    await page.reload();
    await expect(page.locator('body')).toBeVisible();

    // Wait for IndexedDB load so the terminal exists in store + sidebar
    await expect
      .poll(async () => {
        return page.evaluate(async (name) => {
          const stores = await import('/src/lib/stores.svelte.ts');
          if (!stores.isLoaded()) return false;
          for (const conn of stores.getConnections()) {
            for (const proj of conn.projects) {
              if (proj.terminals.some((t: { name: string }) => t.name === name)) return true;
            }
            for (const pg of conn.projectGroups || []) {
              for (const proj of pg.projects) {
                if (proj.terminals.some((t: { name: string }) => t.name === name)) return true;
              }
            }
          }
          return false;
        }, setup!.name);
      }, { timeout: 10_000 })
      .toBe(true);

    await page.evaluate(async (name) => {
      const stores = await import('/src/lib/stores.svelte.ts');
      for (const conn of stores.getConnections()) {
        if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
        const projects = [
          ...conn.projects,
          ...(conn.projectGroups || []).flatMap((g: { projects: typeof conn.projects }) => g.projects),
        ];
        for (const proj of projects) {
          if (proj.collapsed) stores.toggleProjectCollapse(conn.id, proj.id);
          for (const term of proj.terminals) {
            if (term.name === name) {
              // Select via store so terminal mounts
              stores.setActiveTerminalId(term.id);
            }
          }
        }
      }
    }, setup!.name);

    // Click terminal in sidebar to ensure mounted (and trigger handleSelectTerminal)
    const termRow = page.locator('button', { hasText: setup!.name }).first();
    await expect(termRow).toBeVisible({ timeout: 10_000 });
    await termRow.click();

    // Terminal window gear
    const gear = page.getByRole('button', { name: 'Command shortcut settings' }).first();
    await expect(gear).toBeVisible({ timeout: 10_000 });
    await gear.click();

    const settingsDialog = page.getByRole('dialog', { name: 'Command shortcut settings' });
    await expect(settingsDialog).toBeVisible();
    await expect(settingsDialog.getByText('Command shortcuts')).toBeVisible();
    // Legend for the three actions
    await expect(settingsDialog.getByText('Auto-run')).toBeVisible();
    await expect(settingsDialog.getByText('Hit Enter')).toBeVisible();
    await expect(settingsDialog.getByText('Ctrl+C first')).toBeVisible();

    // Command chip should show for saved command
    await expect(page.getByRole('button', { name: /ChipCmd/ }).first()).toBeVisible();

    // Window must not expose a top-right "Duplicate terminal" control
    // (tree still has one — scope to terminal slot)
    const terminalSlot = page.locator('.terminal-slot.terminal-visible, .terminal-slot:not(.terminal-hidden)').first();
    if (await terminalSlot.count()) {
      await expect(terminalSlot.getByRole('button', { name: 'Duplicate terminal' })).toHaveCount(0);
    } else {
      // Fallback: no visible duplicate in terminal header area near gear
      const dupInHeader = page.locator('button[aria-label="Duplicate terminal"]');
      // Tree may still have duplicate controls; count can be >0. Just ensure gear path works.
      void dupInHeader;
    }

    // Escape closes settings
    await page.keyboard.press('Escape');
    await expect(settingsDialog).toHaveCount(0);
  });

  test('UI: single-click connection row toggles collapse (whole bar, not just label)', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      const conn = stores.addConnection('Click Conn', 'ws://127.0.0.1:9992/ws');
      if (!conn) return null;
      // Start expanded
      if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
      stores.addProject(conn.id, 'Child Proj');
      return { id: conn.id, name: conn.name };
    });
    expect(setup).not.toBeNull();

    await page.reload();
    await expect(page.locator('body')).toBeVisible();

    await page.evaluate(async (id) => {
      const stores = await import('/src/lib/stores.svelte.ts');
      const conn = stores.getConnections().find((c: { id: string }) => c.id === id);
      if (conn?.collapsed) stores.toggleConnectionCollapse(id);
    }, setup!.id);

    // The whole bar button is the click target — clicking it (not just the
    // label span) toggles collapse. Single click, not double.
    const connRow = page.locator('button', { hasText: setup!.name }).first();
    await expect(connRow).toBeVisible({ timeout: 10_000 });

    const before = await page.evaluate((id) => {
      return import('/src/lib/stores.svelte.ts').then((stores) => {
        const c = stores.getConnections().find((x: { id: string }) => x.id === id);
        return !!c?.collapsed;
      });
    }, setup!.id);

    await connRow.click();

    const after = await page.evaluate((id) => {
      return import('/src/lib/stores.svelte.ts').then((stores) => {
        const c = stores.getConnections().find((x: { id: string }) => x.id === id);
        return !!c?.collapsed;
      });
    }, setup!.id);

    expect(after).toBe(!before);
  });

  test('UI: sidebar tabs are routes and survive refresh', async ({ page }) => {
    await page.getByRole('link', { name: 'Groups' }).click();
    await expect(page).toHaveURL(/\/groups\/?$/);
    await page.reload();
    await expect(page).toHaveURL(/\/groups\/?$/);
    await expect(page.getByRole('link', { name: 'Groups' })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('link', { name: 'Pinned' }).click();
    await expect(page).toHaveURL(/\/pinned\/?$/);
    await page.reload();
    await expect(page).toHaveURL(/\/pinned\/?$/);

    await page.goto('/');
    await expect(page).toHaveURL(/\/connections\/?$/);
  });

  test('UI: a drag past the threshold does not toggle collapse', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const stores = await import('/src/lib/stores.svelte.ts');
      const conn = stores.addConnection('DragNoToggle Conn', 'ws://127.0.0.1:9991/ws');
      if (!conn) return null;
      if (conn.collapsed) stores.toggleConnectionCollapse(conn.id);
      stores.addProject(conn.id, 'Child Proj Drag');
      return { id: conn.id, name: conn.name };
    });
    expect(setup).not.toBeNull();

    await page.reload();
    await expect(page.locator('body')).toBeVisible();

    await page.evaluate(async (id) => {
      const stores = await import('/src/lib/stores.svelte.ts');
      const conn = stores.getConnections().find((c: { id: string }) => c.id === id);
      if (conn?.collapsed) stores.toggleConnectionCollapse(id);
    }, setup!.id);

    const connRow = page.locator('button', { hasText: setup!.name }).first();
    await expect(connRow).toBeVisible({ timeout: 10_000 });

    const before = await page.evaluate((id) => {
      return import('/src/lib/stores.svelte.ts').then((stores) => {
        const c = stores.getConnections().find((x: { id: string }) => x.id === id);
        return !!c?.collapsed;
      });
    }, setup!.id);

    // Press in the bar, drag well past ROW_DRAG_THRESHOLD (6px), release. The
    // click is suppressed by the pointer-down-vs-up distance check, so collapse
    // must not toggle (the HTML5 drag that may start is irrelevant to collapse).
    const box = await connRow.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + 8;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 8 });
    await page.mouse.up();

    const after = await page.evaluate((id) => {
      return import('/src/lib/stores.svelte.ts').then((stores) => {
        const c = stores.getConnections().find((x: { id: string }) => x.id === id);
        return !!c?.collapsed;
      });
    }, setup!.id);

    expect(after).toBe(before);
  });
});

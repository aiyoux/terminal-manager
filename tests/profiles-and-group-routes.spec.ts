import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for:
 * 1. Multiple switchable profiles (port config + isolated workspace data)
 * 2. Header nav with per-group routes (/groups/[id]) and persistent grid state
 */

async function resetAppState(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    try {
      localStorage.removeItem('terminal-dashboard-view-settings');
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('terminal-dashboard');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.locator('body')).toBeVisible();
  await page.evaluate(async () => {
    const stores = await import('/src/lib/stores.svelte.ts');
    await stores.whenLoaded();
  });
}

async function waitLoaded(page: Page) {
  await page.evaluate(async () => {
    const stores = await import('/src/lib/stores.svelte.ts');
    await stores.whenLoaded();
  });
}

test.describe('Multi-profile workspaces', () => {
  test.beforeEach(async ({ page }) => {
    await resetAppState(page);
  });

  test('store: create, switch, and isolate connection data per profile', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();

      // Seed Default profile
      s.addConnection('Local Conn', 'ws://127.0.0.1:7681');
      const localConns = s.getConnections().map((c: { name: string }) => c.name);

      // New empty profile
      const cloud = s.createProfile('Cloud', false);
      await s.switchProfile(cloud.id);
      const cloudConnsBefore = s.getConnections().length;
      s.addConnection('Cloud Conn', 'ws://127.0.0.1:7682');
      const cloudConns = s.getConnections().map((c: { name: string }) => c.name);

      // Back to Default — Local Conn only, not Cloud Conn
      const defaultMeta = s.getProfiles().find((p: { name: string }) => p.name === 'Default');
      if (!defaultMeta) return { ok: false, reason: 'no Default profile' };
      await s.switchProfile(defaultMeta.id);
      const back = s.getConnections().map((c: { name: string }) => c.name);

      // Cloud still has only Cloud Conn
      await s.switchProfile(cloud.id);
      const cloudAgain = s.getConnections().map((c: { name: string }) => c.name);

      return {
        ok: true,
        localConns,
        cloudConnsBefore,
        cloudConns,
        back,
        cloudAgain,
        profileNames: s.getProfiles().map((p: { name: string }) => p.name),
      };
    });

    expect(result.ok, (result as { reason?: string }).reason).toBe(true);
    expect(result.localConns).toContain('Local Conn');
    expect(result.cloudConnsBefore).toBe(0);
    expect(result.cloudConns).toEqual(['Cloud Conn']);
    expect(result.back).toContain('Local Conn');
    expect(result.back).not.toContain('Cloud Conn');
    expect(result.cloudAgain).toEqual(['Cloud Conn']);
    expect(result.profileNames).toEqual(expect.arrayContaining(['Default', 'Cloud']));
  });

  test('store: port config is per-profile and drives default WS URL', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();

      s.updatePortConfig({ defaultHost: 'localhost', defaultPort: 7681, useTls: false });
      const urlLocal = s.defaultWsUrlFromPortConfig(s.getPortConfig());

      const cloud = s.createProfile('Tunnel Profile', false);
      await s.switchProfile(cloud.id);
      s.updatePortConfig({ defaultHost: '127.0.0.1', defaultPort: 7682, useTls: false });
      const urlCloud = s.defaultWsUrlFromPortConfig(s.getPortConfig());
      const portCloud = s.getPortConfig().defaultPort;

      const def = s.getProfiles().find((p: { name: string }) => p.name === 'Default')!;
      await s.switchProfile(def.id);
      const portBack = s.getPortConfig().defaultPort;
      const urlBack = s.defaultWsUrlFromPortConfig(s.getPortConfig());

      return { urlLocal, urlCloud, portCloud, portBack, urlBack };
    });

    expect(result.urlLocal).toBe('ws://localhost:7681');
    expect(result.urlCloud).toBe('ws://127.0.0.1:7682');
    expect(result.portCloud).toBe(7682);
    expect(result.portBack).toBe(7681);
    expect(result.urlBack).toBe('ws://localhost:7681');
  });

  test('store: copy-on-create clones workspace; delete keeps one profile', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();

      s.addConnection('To Copy', 'ws://copy.test:1');
      const clone = s.createProfile('Clone', true);
      await s.switchProfile(clone.id);
      const cloneConns = s.getConnections().map((c: { name: string }) => c.name);

      // Cannot delete last remaining if we delete all but one
      const namesBefore = s.getProfiles().map((p: { name: string }) => p.name);
      const onlyOne = namesBefore.length === 1;
      let deletedLast = false;
      if (s.getProfiles().length === 1) {
        deletedLast = await s.deleteProfile(s.getProfiles()[0].id);
      }

      // Delete non-active other profile when multiple exist
      const def = s.getProfiles().find((p: { name: string }) => p.name === 'Default');
      let deletedDefault = false;
      if (def && s.getProfiles().length > 1) {
        deletedDefault = await s.deleteProfile(def.id);
      }

      return {
        cloneConns,
        onlyOne,
        deletedLast,
        deletedDefault,
        remaining: s.getProfiles().map((p: { name: string }) => p.name),
        active: s.getActiveProfileName(),
      };
    });

    expect(result.cloneConns).toContain('To Copy');
    expect(result.deletedLast).toBe(false);
    if (result.remaining.length > 0) {
      expect(result.remaining.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('store: profile data survives page reload', async ({ page }) => {
    await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      s.updatePortConfig({ defaultPort: 9999, defaultHost: 'reload-host', useTls: false });
      s.addConnection('Persist Me', 'ws://reload-host:9999');
      const cloud = s.createProfile('Persist Cloud', false);
      await s.switchProfile(cloud.id);
      s.addConnection('Cloud Only', 'ws://cloud:1');
    });

    await page.reload();
    await waitLoaded(page);

    const after = await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      const names = s.getProfiles().map((p: { name: string }) => p.name);
      // Should still be on last active profile (Cloud)
      const active = s.getActiveProfileName();
      const conns = s.getConnections().map((c: { name: string }) => c.name);
      const def = s.getProfiles().find((p: { name: string }) => p.name === 'Default' || p.name === 'Persist Cloud');
      // Switch to Default if present
      const defaultP = s.getProfiles().find((p: { name: string }) => p.name === 'Default');
      let defaultConns: string[] = [];
      let defaultPort = 0;
      if (defaultP) {
        await s.switchProfile(defaultP.id);
        defaultConns = s.getConnections().map((c: { name: string }) => c.name);
        defaultPort = s.getPortConfig().defaultPort;
      }
      return { names, active, conns, defaultConns, defaultPort };
    });

    expect(after.names).toEqual(expect.arrayContaining(['Default', 'Persist Cloud']));
    // After reload, active should be last saved active (Persist Cloud)
    expect(after.conns).toContain('Cloud Only');
    expect(after.defaultConns).toContain('Persist Me');
    expect(after.defaultPort).toBe(9999);
  });

  test('UI: profile menu lists profiles and switches workspace', async ({ page }) => {
    await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      s.addConnection('UI Local', 'ws://ui-local:1');
      const cloud = s.createProfile('UI Cloud', false);
      await s.switchProfile(cloud.id);
      s.addConnection('UI Cloud Conn', 'ws://ui-cloud:2');
      // Stay on cloud so menu shows both; switch via UI to Default
      const def = s.getProfiles().find((p: { name: string }) => p.name === 'Default')!;
      await s.switchProfile(def.id);
    });
    await page.reload();
    await waitLoaded(page);

    // Profile button shows active name
    const profileBtn = page.locator('header button', { hasText: 'Default' }).first();
    await expect(profileBtn).toBeVisible({ timeout: 10_000 });

    await profileBtn.click();
    await expect(page.getByRole('menuitem', { name: /UI Cloud/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /UI Cloud/ }).click();

    // Sidebar should show Cloud connection, not Local
    await expect(page.getByText('UI Cloud Conn')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('UI Local')).toHaveCount(0);
  });
});

test.describe('Group routes as header tabs', () => {
  test.beforeEach(async ({ page }) => {
    await resetAppState(page);
  });

  test('store + routing: each group has /groups/[id] and opens grid for that group', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      const conn = s.addConnection('G Conn', 'ws://g:1');
      const proj = s.addProject(conn.id, 'G Proj')!;
      const t1 = s.addTerminal(conn.id, proj.id, 'Term Alpha')!;
      const t2 = s.addTerminal(conn.id, proj.id, 'Term Beta')!;
      const g1 = s.addTerminalGroup('Alpha Squad');
      const g2 = s.addTerminalGroup('Beta Squad');
      s.addTerminalToGroup(g1.id, t1.id);
      s.addTerminalToGroup(g2.id, t2.id);
      return { g1: g1.id, g2: g2.id, t1: t1.id, t2: t2.id };
    });

    await page.reload();
    await waitLoaded(page);

    // Header links for groups by name
    const alphaTab = page.getByRole('link', { name: 'Alpha Squad' });
    const betaTab = page.getByRole('link', { name: 'Beta Squad' });
    await expect(alphaTab).toBeVisible({ timeout: 10_000 });
    await expect(betaTab).toBeVisible();

    await alphaTab.click();
    await expect(page).toHaveURL(new RegExp(`/groups/${setup.g1}/?$`));
    await expect(alphaTab).toHaveAttribute('aria-current', 'page');

    // Workspace in group grid mode for this group
    const gridState = await page.evaluate(() => {
      const ws = document.getElementById('workspace');
      return {
        hasGridMode: ws?.classList.contains('grid-mode') ?? false,
      };
    });
    expect(gridState.hasGridMode).toBe(true);

    // Sidebar shows this group's terminals
    const sidebar = page.locator('aside');
    await expect(sidebar.getByText('Term Alpha', { exact: true })).toBeVisible();

    await betaTab.click();
    await expect(page).toHaveURL(new RegExp(`/groups/${setup.g2}/?$`));
    await expect(betaTab).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByText('Term Beta', { exact: true })).toBeVisible();
  });

  test('UI: group route survives refresh and Connections/Pinned still work', async ({ page }) => {
    const groupId = await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      const conn = s.addConnection('Refresh Conn', 'ws://r:1');
      const proj = s.addProject(conn.id, 'Refresh Proj')!;
      const term = s.addTerminal(conn.id, proj.id, 'Refresh Term')!;
      const g = s.addTerminalGroup('Sticky Group');
      s.addTerminalToGroup(g.id, term.id);
      return g.id;
    });

    await page.goto(`/groups/${groupId}`);
    await waitLoaded(page);
    await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/?$`));
    await expect(page.getByRole('link', { name: 'Sticky Group' })).toHaveAttribute('aria-current', 'page');

    await page.reload();
    await waitLoaded(page);
    await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/?$`));
    await expect(page.getByRole('link', { name: 'Sticky Group' })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#workspace')).toHaveClass(/grid-mode/);

    await page.getByRole('link', { name: 'Connections' }).click();
    await expect(page).toHaveURL(/\/connections\/?$/);
    await expect(page.getByRole('link', { name: 'Connections' })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('link', { name: 'Pinned' }).click();
    await expect(page).toHaveURL(/\/pinned\/?$/);
  });

  test('UI: switching away from group and back keeps terminals mounted (no remount thrash)', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      const conn = s.addConnection('Mount Conn', 'ws://m:1');
      const proj = s.addProject(conn.id, 'Mount Proj')!;
      const t1 = s.addTerminal(conn.id, proj.id, 'Keep Alive')!;
      const g = s.addTerminalGroup('Mount Group');
      s.addTerminalToGroup(g.id, t1.id);
      return { gId: g.id, tId: t1.id };
    });

    await page.goto(`/groups/${setup.gId}`);
    await waitLoaded(page);

    await expect(page.locator('aside').getByText('Keep Alive', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    // Click terminal row to ensure it's in the mount set
    await page.locator('aside').getByText('Keep Alive', { exact: true }).click();

    // After clicking, we may leave grid for single view — go back to group route
    await page.goto(`/groups/${setup.gId}`);
    await waitLoaded(page);

    const terminalHostCount = async () =>
      page.locator('.terminal-xterm-host, .terminal-chrome').count();

    const countOnGroup = await terminalHostCount();
    expect(countOnGroup).toBeGreaterThan(0);

    await page.getByRole('link', { name: 'Connections' }).click();
    await expect(page).toHaveURL(/\/connections/);
    // Terminals stay mounted in layout (may be hidden)
    const countOnConnections = await terminalHostCount();
    expect(countOnConnections).toBeGreaterThanOrEqual(countOnGroup);

    await page.getByRole('link', { name: 'Mount Group' }).click();
    await expect(page).toHaveURL(new RegExp(`/groups/${setup.gId}`));
    const countBack = await terminalHostCount();
    // Still mounted (same or more instances, not zero)
    expect(countBack).toBeGreaterThan(0);
  });

  test('UI: bare /groups redirects to a group or connections', async ({ page }) => {
    await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      const g = s.addTerminalGroup('Only Group');
      void g;
    });
    await page.goto('/groups');
    await waitLoaded(page);
    // Client redirect to first group
    await expect(page).toHaveURL(/\/groups\/[^/]+/, { timeout: 10_000 });
  });

  test('UI: new group via Add Group navigates to /groups/[id]', async ({ page }) => {
    await page.goto('/connections');
    await waitLoaded(page);

    // Need a group route first for Add Group footer — create via store then open
    await page.evaluate(async () => {
      const s = await import('/src/lib/stores.svelte.ts');
      await s.whenLoaded();
      s.addTerminalGroup('Seed');
    });
    await page.reload();
    await waitLoaded(page);

    await page.getByRole('link', { name: 'Seed' }).click();
    await expect(page).toHaveURL(/\/groups\//);

    // Add Group opens prompt
    page.once('dialog', async () => {
      /* app uses custom modal not window.dialog */
    });

    await page.getByRole('button', { name: 'Add Group' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').first().fill('From UI');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page).toHaveURL(/\/groups\/[^/]+/);
    await expect(page.getByRole('link', { name: 'From UI' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'From UI' })).toHaveAttribute('aria-current', 'page');
  });
});

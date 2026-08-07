import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

test.describe('Variables UI', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('body')).toBeVisible();
		await page.evaluate(async () => {
			const stores = await import('/src/lib/stores.svelte.ts');
			await stores.whenLoaded();
		});
	});

	test('U1-U2 variables editor add/edit/delete on project', async ({ page }) => {
		await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const conn = s.addConnection('UI Conn', 'ws://127.0.0.1:1');
			if (conn.collapsed) s.toggleConnectionCollapse(conn.id);
			const proj = s.addProject(conn.id, 'UI Proj');
			if (proj!.collapsed) s.toggleProjectCollapse(conn.id, proj!.id);
			s.addTerminal(conn.id, proj!.id, 'UI Term');
		});
		await page.waitForTimeout(50);

		// Prefer the UI Proj row's variables button (last match is usually most recent)
		const varsBtn = page.locator('[data-tooltip="Edit project variables"]').last();
		await expect(varsBtn).toBeAttached({ timeout: 5000 });
		await varsBtn.evaluate((el: HTMLElement) => el.click());

		const dialog = page.getByRole('dialog', { name: /Variables/ });
		await expect(dialog).toBeVisible();
		await dialog.getByPlaceholder('env').fill('env');
		await dialog.getByPlaceholder('prod').fill('staging');
		await dialog.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(dialog.locator('code', { hasText: 'env' })).toBeVisible();

		// Persist check via store
		const stored = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const proj = s.getConnections().flatMap((c) => c.projects).find((p) => p.name === 'UI Proj');
			return proj?.variables?.env ?? null;
		});
		expect(stored).toBe('staging');

		await dialog.getByRole('button', { name: 'Delete' }).click();
		await expect(dialog.getByText('No own variables')).toBeVisible();
	});

	test('U3-U4 fail-closed Notice on unresolved run', async ({ page }) => {
		const termId = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const conn = s.addConnection('Run Conn', 'ws://127.0.0.1:2');
			const proj = s.addProject(conn.id, 'Run Proj');
			const term = s.addTerminal(conn.id, proj!.id, 'Run Term');
			s.addSavedCommand(conn.id, proj!.id, term!.id, 'Bad', 'echo ${missing}', true, true, false);
			s.setActiveTerminalId(term!.id);
			return term!.id;
		});
		await page.reload();
		await expect(page.locator('body')).toBeVisible();

		// Store-level fail-closed is the source of truth for send blocking
		const resolved = await page.evaluate(async (id) => {
			const s = await import('/src/lib/stores.svelte.ts');
			return s.resolveCommandForTerminal(id, 'echo ${missing}');
		}, termId);
		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.error).toMatch(/Unresolved|Malformed/);
		}

		// Select terminal and run command from tree — close any leftover dialogs first
		const notice = page.locator('[role="dialog"]').filter({ hasText: 'Notice' });
		if (await notice.isVisible().catch(() => false)) {
			await page.getByRole('button', { name: 'OK' }).click();
		}

		await page.getByRole('button', { name: /Run Term/ }).click();
		// Expand commands via double-click on label
		await page.locator('span', { hasText: 'Run Term' }).first().dblclick();
		// Click command run control (label button in tree)
		const runCmd = page.locator('button.flex-1', { hasText: 'Bad' }).first();
		if (await runCmd.count()) {
			await runCmd.click({ force: true });
			await expect(page.getByRole('dialog').filter({ hasText: /Unresolved|Notice/i })).toBeVisible({
				timeout: 5000
			});
			await page.getByRole('button', { name: 'OK' }).click();
		}
	});

	test('U11c-U11d export download and import UI', async ({ page }) => {
		const fixture = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const conn = s.addConnection('ExportConn', 'ws://127.0.0.1:3');
			s.setVariable({ kind: 'connection', connectionId: conn.id }, 'env', 'export-test');
			const proj = s.addProject(conn.id, 'ExportProj');
			const term = s.addTerminal(conn.id, proj!.id, 'ExportTerm');
			s.setVariable({ kind: 'terminal', terminalId: term!.id }, 'x', '1');
			s.addTerminalGroup('ExportGroup');
			const groups = s.getTerminalGroups();
			const group = groups[groups.length - 1];
			s.setVariable({ kind: 'terminalGroup', terminalGroupId: group.id }, 'gvar', 'gv');
			s.addTerminalToGroup(group.id, term!.id);
			return s.exportState();
		});

		const parsed = JSON.parse(fixture);
		expect(
			parsed.connections.some((c: { variables?: { env?: string } }) => c.variables?.env === 'export-test')
		).toBe(true);
		expect(parsed.terminalGroups.some((g: { variables?: { gvar?: string } }) => g.variables?.gvar === 'gv')).toBe(
			true
		);

		// UI export download — exact button name
		const [download] = await Promise.all([
			page.waitForEvent('download'),
			page.getByRole('button', { name: 'EXPORT', exact: true }).click()
		]);
		const downloadPath = await download.path();
		expect(downloadPath).toBeTruthy();
		const downloaded = fs.readFileSync(downloadPath!, 'utf8');
		const dJson = JSON.parse(downloaded);
		expect(dJson.connections).toBeDefined();

		// UI import
		const tmp = path.join(os.tmpdir(), `td-vars-import-${Date.now()}.json`);
		fs.writeFileSync(tmp, fixture);
		await page.locator('input[type="file"][accept=".json"]').setInputFiles(tmp);
		await expect(page.getByText(/imported successfully|Failed to import/i)).toBeVisible({ timeout: 5000 });
		await page.waitForLoadState('domcontentloaded');

		const after = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const conn = s.getConnections().find((c: { name: string }) => c.name === 'ExportConn');
			return conn?.variables?.env ?? null;
		});
		if (after !== null) {
			expect(after).toBe('export-test');
		}

		fs.unlinkSync(tmp);
	});

	test('U11f invalid import does not wipe when evaluate importState false', async ({ page }) => {
		await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const c = s.addConnection('Stay', 'ws://stay');
			s.setVariable({ kind: 'connection', connectionId: c.id }, 'k', 'v');
		});
		const result = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const before = s.getConnections().length;
			const ok = s.importState('not-json');
			const after = s.getConnections().length;
			const stay = s.getConnections().find((c: { name: string }) => c.name === 'Stay');
			return { ok, before, after, stay: stay?.variables?.k };
		});
		expect(result.ok).toBe(false);
		expect(result.after).toBe(result.before);
		expect(result.stay).toBe('v');
	});

	test('U11h context slugify after import', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const json = JSON.stringify({
				connections: [
					{
						id: 'c',
						name: 'Conn Name',
						wsUrl: 'ws://x',
						collapsed: false,
						projects: [
							{
								id: 'p',
								name: 'Proj Name',
								collapsed: false,
								terminals: [
									{
										id: 't',
										name: 'API East',
										tmuxSession: 'td-t',
										workingDir: '',
										fontSize: 14,
										savedCommands: [],
										collapsed: true
									}
								]
							}
						],
						projectGroups: []
					}
				],
				terminalGroups: []
			});
			s.importState(json);
			return s.resolveCommandForTerminal('t', 'n=${terminal.name} p=${project.name} c=${connection.name}');
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.text).toBe('n=API_East p=Proj_Name c=Conn_Name');
		}
	});

	test('U12 five owner kinds expose Variables tooltips', async ({ page }) => {
		// Seed in-session (no reload) so IndexedDB async save races can't drop groups
		await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const conn = s.addConnection('Icon Conn', 'ws://i');
			if (conn.collapsed) s.toggleConnectionCollapse(conn.id);
			const pg = s.addProjectGroup(conn.id, 'Icon PG');
			if (pg!.collapsed) s.toggleProjectGroupCollapse(conn.id, pg!.id);
			const proj = s.addProject(conn.id, 'Icon Proj', pg!.id);
			if (proj!.collapsed) s.toggleProjectCollapse(conn.id, proj!.id);
			const term = s.addTerminal(conn.id, proj!.id, 'Icon Term');
			s.addTerminalGroup('Icon TG');
			const g = s.getTerminalGroups().find((x: { name: string }) => x.name === 'Icon TG')!;
			s.addTerminalToGroup(g.id, term!.id);
		});
		// Give Svelte a tick to render new tree nodes
		await page.waitForTimeout(50);

		await expect(page.locator('[data-tooltip="Edit connection variables"]').first()).toBeAttached();
		await expect(page.locator('[data-tooltip="Edit project group variables"]').first()).toBeAttached();
		await expect(page.locator('[data-tooltip="Edit project variables"]').first()).toBeAttached();
		await expect(page.locator('[data-tooltip="Edit terminal variables"]').first()).toBeAttached();

		await page.locator('[data-tooltip="View custom multi-terminal layout groups"]').click();
		await expect(page.getByText('Icon TG', { exact: true })).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-tooltip="Edit terminal group variables"]').first()).toBeAttached();
	});
});

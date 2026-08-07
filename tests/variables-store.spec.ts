import { test, expect } from '@playwright/test';

/**
 * Store-level hierarchical variables + text replace + import/export.
 */
test.describe('Variables store', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('body')).toBeVisible();
		await page.evaluate(async () => {
			const stores = await import('/src/lib/stores.svelte.ts');
			await stores.whenLoaded();
		});
	});

	async function seedHierarchy(page: import('@playwright/test').Page) {
		return page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const conn = s.addConnection('Prod Conn', 'ws://127.0.0.1:9999/ws');
			const pg = s.addProjectGroup(conn.id, 'Pay Group');
			const proj = s.addProject(conn.id, 'API Project', pg!.id);
			const term = s.addTerminal(conn.id, proj!.id, 'API East');
			s.setVariable({ kind: 'connection', connectionId: conn.id }, 'env', 'prod');
			s.setVariable({ kind: 'projectGroup', connectionId: conn.id, projectGroupId: pg!.id }, 'env', 'prod-payments');
			s.setVariable({ kind: 'project', projectId: proj!.id }, 'svc', 'api');
			s.setVariable({ kind: 'terminal', terminalId: term!.id }, 'port', '8080');
			const tg = s.addTerminalGroup('oncall');
			const groups = s.getTerminalGroups();
			const group = groups[groups.length - 1];
			s.addTerminalToGroup(group.id, term!.id);
			s.setVariable({ kind: 'terminalGroup', terminalGroupId: group.id }, 'pager', 'P123');
			s.addSavedCommand(
				conn.id,
				proj!.id,
				term!.id,
				'Deploy',
				'deploy --env=${env} --svc=${svc} --port=${port} --name=${terminal.name} --pager=${pager}',
				true,
				false,
				false
			);
			s.addSavedCommand(conn.id, proj!.id, term!.id, 'Boot', 'echo ${env}', true, false, true);
			s.addSavedCommand(conn.id, proj!.id, term!.id, 'BadBoot', 'echo ${missing}', true, false, true);
			return {
				connId: conn.id,
				pgId: pg!.id,
				projId: proj!.id,
				termId: term!.id,
				groupId: group.id
			};
		});
	}

	test('V2-V9 hierarchy merge + context slugify + system keys', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async (termId) => {
			const s = await import('/src/lib/stores.svelte.ts');
			const r = s.resolveCommandForTerminal(
				termId,
				'deploy --env=${env} --svc=${svc} --port=${port} --name=${terminal.name} --pager=${pager}'
			);
			const map = s.getEffectiveVariablesForTerminal(termId);
			return {
				r,
				env: map?.get('env'),
				terminalName: map?.get('terminal.name'),
				connName: map?.get('connection.name'),
				hasProjectGroup: map?.has('projectGroup.name')
			};
		}, ids.termId);

		expect(result.r.ok).toBe(true);
		if (result.r.ok) {
			expect(result.r.text).toBe(
				'deploy --env=prod-payments --svc=api --port=8080 --name=API_East --pager=P123'
			);
		}
		expect(result.env).toBe('prod-payments');
		expect(result.terminalName).toBe('API_East');
		expect(result.connName).toBe('Prod_Conn');
		expect(result.hasProjectGroup).toBe(true);
	});

	test('V15 partial on-connect resolution', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async (termId) => {
			const s = await import('/src/lib/stores.svelte.ts');
			const res = s.getOnConnectResolution(termId);
			return res;
		}, ids.termId);

		expect(result.commands).toEqual(['echo prod-payments']);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0].label).toBe('BadBoot');
		expect(result.errors[0].error).toContain('Unresolved');
	});

	test('V16 duplicateTerminal copies variables independently', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async ({ connId, projId, termId }) => {
			const s = await import('/src/lib/stores.svelte.ts');
			const dup = s.duplicateTerminal(connId, projId, termId);
			if (!dup) return { ok: false };
			s.setVariable({ kind: 'terminal', terminalId: dup.id }, 'port', '9090');
			const orig = s.getOwnVariables({ kind: 'terminal', terminalId: termId });
			const copy = s.getOwnVariables({ kind: 'terminal', terminalId: dup.id });
			return { ok: true, origPort: orig.port, copyPort: copy.port };
		}, ids);

		expect(result.ok).toBe(true);
		expect(result.origPort).toBe('8080');
		expect(result.copyPort).toBe('9090');
	});

	test('V18/V18b normalize on import soft-sanitizes variables', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const bad = {
				connections: [
					{
						id: 'c1',
						name: 'C',
						wsUrl: 'ws://x',
						collapsed: false,
						variables: { __proto__: { x: 1 }, ok: 'yes', bad: 1 },
						projects: [
							{
								id: 'p1',
								name: 'P',
								collapsed: false,
								variables: ['not', 'object'],
								terminals: [
									{
										id: 't1',
										name: 'T',
										tmuxSession: 'td-t1',
										workingDir: '',
										fontSize: 14,
										savedCommands: [],
										collapsed: true,
										variables: { env: 'prod' }
									}
								]
							}
						],
						projectGroups: []
					}
				],
				terminalGroups: [
					{
						id: 'g1',
						name: 'G',
						terminalIds: ['t1'],
						collapsed: false,
						variables: { pager: 'P1' }
					}
				]
			};
			const ok = s.importState(JSON.stringify(bad));
			const conn = s.getConnections().find((c) => c.id === 'c1');
			const r = s.resolveCommandForTerminal('t1', 'echo ${env} ${pager}');
			return {
				ok,
				connVars: conn?.variables,
				projVars: conn?.projects[0]?.variables,
				resolve: r
			};
		});

		expect(result.ok).toBe(true);
		expect(result.connVars).toEqual({ ok: 'yes' });
		expect(result.projVars).toEqual({});
		expect(result.resolve.ok).toBe(true);
		if (result.resolve.ok) expect(result.resolve.text).toBe('echo prod P1');
	});

	test('V19 bare terminal allowed; dotted user key rejected', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const conn = s.addConnection('C', 'ws://x');
			const a = s.setVariable({ kind: 'connection', connectionId: conn.id }, 'terminal', 'ok');
			const b = s.setVariable({ kind: 'connection', connectionId: conn.id }, 'terminal.name', 'no');
			return { a, b };
		});
		expect(result.a.ok).toBe(true);
		expect(result.b.ok).toBe(false);
	});

	test('V20-V22 text replace literal and toVariable ensure', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async ({ projId, termId }) => {
			const s = await import('/src/lib/stores.svelte.ts');
			// literal replace on project scope
			const p1 = s.previewCommandTextReplace({
				scopeRef: { kind: 'project', projectId: projId },
				find: 'deploy',
				mode: 'literal',
				replace: 'rollout',
				replaceAll: true
			});
			if (!p1.ok) return { step: 'p1', p1 };
			const a1 = s.applyCommandTextReplace(p1);

			// toVariable with ensure on project
			s.addSavedCommand(
				s.findTerminalById(termId)!.conn.id,
				projId,
				termId,
				'Region',
				'region=us-east-1',
				true,
				false,
				false
			);
			const p2 = s.previewCommandTextReplace({
				scopeRef: { kind: 'project', projectId: projId },
				find: 'us-east-1',
				mode: 'toVariable',
				variableKey: 'region',
				ensureVariable: true,
				requireInScope: true
			});
			if (!p2.ok) return { step: 'p2', p2 };
			const a2 = s.applyCommandTextReplace(p2);
			const own = s.getOwnVariables({ kind: 'project', projectId: projId });
			const term = s.findTerminalById(termId)!.terminal;
			const regionCmd = term.savedCommands.find((c) => c.label === 'Region');
			return {
				step: 'ok',
				a1,
				a2,
				region: own.region,
				regionCmd: regionCmd?.command,
				empty: s.previewCommandTextReplace({
					scopeRef: { kind: 'project', projectId: projId },
					find: '',
					mode: 'literal',
					replace: 'x'
				})
			};
		}, ids);

		expect(result.step).toBe('ok');
		expect(result.a1?.applied).toBeGreaterThan(0);
		expect(result.region).toBe('us-east-1');
		expect(result.regionCmd).toBe('region=${region}');
		expect(result.empty).toMatchObject({ ok: false });
	});

	test('V22f TerminalGroup ensure + requireInScope members only', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async ({ groupId, termId, connId, projId }) => {
			const s = await import('/src/lib/stores.svelte.ts');
			// Non-member terminal
			const other = s.addTerminal(connId, projId, 'Other');
			s.addSavedCommand(connId, projId, other!.id, 'X', 'token=secret', true, false, false);
			s.addSavedCommand(connId, projId, termId, 'Y', 'token=secret', true, false, false);

			const preview = s.previewCommandTextReplace({
				scopeRef: { kind: 'terminalGroup', terminalGroupId: groupId },
				find: 'secret',
				mode: 'toVariable',
				variableKey: 'tok',
				ensureVariable: true,
				requireInScope: true
			});
			if (!preview.ok) return { ok: false, preview };
			return {
				ok: true,
				matchTermIds: preview.matches.map((m) => m.terminalId),
				member: termId,
				nonMember: other!.id
			};
		}, ids);

		expect(result.ok).toBe(true);
		expect(result.matchTermIds).toContain(result.member);
		expect(result.matchTermIds).not.toContain(result.nonMember);
	});

	test('V25 removeProjectGroup deletes nested projects', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async ({ connId, pgId, projId, termId }) => {
			const s = await import('/src/lib/stores.svelte.ts');
			s.removeProjectGroup(connId, pgId);
			return {
				proj: s.findProjectById(projId),
				term: s.findTerminalById(termId)
			};
		}, ids);
		expect(result.proj).toBeNull();
		expect(result.term).toBeNull();
	});

	test('V26-V27 export/import round-trip preserves variables', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async ({ connId, groupId, termId }) => {
			const s = await import('/src/lib/stores.svelte.ts');
			const json = s.exportState();
			const parsed = JSON.parse(json);
			const conn = parsed.connections.find((c: { id: string }) => c.id === connId);
			const tg = parsed.terminalGroups.find((g: { id: string }) => g.id === groupId);
			const exportOk =
				conn?.variables?.env === 'prod' &&
				tg?.variables?.pager === 'P123' &&
				!!conn?.projectGroups?.[0]?.projects?.[0]?.terminals?.[0]?.variables?.port;

			// Import into same session (overwrites)
			const ok = s.importState(json);
			const r = s.resolveCommandForTerminal(
				termId,
				'deploy --env=${env} --svc=${svc} --port=${port} --name=${terminal.name} --pager=${pager}'
			);
			return { exportOk, ok, r };
		}, ids);

		expect(result.exportOk).toBe(true);
		expect(result.ok).toBe(true);
		expect(result.r.ok).toBe(true);
		if (result.r.ok) {
			expect(result.r.text).toContain('prod-payments');
			expect(result.r.text).toContain('API_East');
		}
	});

	test('V28 import failures and pre-variables backups', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const s = await import('/src/lib/stores.svelte.ts');
			const keep = s.addConnection('Keep Me', 'ws://keep');
			s.setVariable({ kind: 'connection', connectionId: keep.id }, 'stay', 'yes');

			const garbage = s.importState('{not json');
			const still = s.getConnections().some((c) => c.id === keep.id && c.variables?.stay === 'yes');

			const oldShape = s.importState(
				JSON.stringify([
					{
						id: 'old1',
						name: 'Old',
						wsUrl: 'ws://old',
						collapsed: false,
						projects: [
							{
								id: 'op1',
								name: 'OP',
								collapsed: false,
								terminals: [
									{
										id: 'ot1',
										name: 'OT Space',
										tmuxSession: 'td-ot1',
										workingDir: '',
										fontSize: 14,
										savedCommands: [{ id: 'oc1', label: 'L', command: 'echo hi', isOnConnect: false }],
										collapsed: true
									}
								]
							}
						]
					}
				])
			);
			// note: array-only old format becomes connections
			const r = s.resolveCommandForTerminal(
				s.getConnections().flatMap((c) => c.projects).flatMap((p) => p.terminals).find((t) => t.name === 'OT Space')
					?.id || '',
				'echo ${terminal.name}'
			);
			return { garbage, still, oldShape, r };
		});

		expect(result.garbage).toBe(false);
		// garbage import shouldn't wipe — but note: oldShape import may have replaced connections
		// Actually importState on success replaces all connections. garbage returns false without wipe.
		expect(result.still).toBe(true);
		expect(result.oldShape).toBe(true);
		// After oldShape success, keep is gone — that's correct import behavior
		// Re-check slugify on imported name
		if (result.r.ok) {
			expect(result.r.text).toBe('echo OT_Space');
		}
	});

	test('unresolved does not send — resolve-only helper path', async ({ page }) => {
		const ids = await seedHierarchy(page);
		const result = await page.evaluate(async (termId) => {
			const s = await import('/src/lib/stores.svelte.ts');
			const r = s.resolveCommandForTerminal(termId, 'echo ${nope}');
			return r;
		}, ids.termId);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('Unresolved');
	});
});

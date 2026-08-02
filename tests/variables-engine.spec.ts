import { test, expect } from '@playwright/test';

/**
 * Pure engine tests for src/lib/variables.ts
 * Loaded via page.evaluate so Vite serves the module.
 */
test.describe('Variables engine', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('body')).toBeVisible();
	});

	test('V1 plain text unchanged', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			const r = v.resolveTemplate('echo hello', new Map());
			return r;
		});
		expect(result).toMatchObject({ ok: true, text: 'echo hello' });
	});

	test('V10 unresolved key', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			return v.resolveTemplate('echo ${missing}', new Map());
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errorKind).toBe('unresolved');
			expect(result.error).toContain('Unresolved variable(s): missing');
			expect(result.unresolved).toContain('missing');
		}
	});

	test('V11 escape $${ → literal ${', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			return v.resolveTemplate('echo $${foo}', new Map());
		});
		expect(result).toMatchObject({ ok: true, text: 'echo ${foo}' });
	});

	test('V12 malformed tokens fail closed', async ({ page }) => {
		const cases = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			const scope = new Map([['env', 'prod']]);
			return {
				badName: v.resolveTemplate('${bad-name}', scope),
				empty: v.resolveTemplate('${}', scope),
				digit: v.resolveTemplate('${1x}', scope),
				fooBar: v.resolveTemplate('${foo-bar}', scope)
			};
		});
		for (const r of Object.values(cases)) {
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errorKind).toBe('malformed');
		}
	});

	test('V12b unclosed ${ fails closed', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			return {
				a: v.resolveTemplate('${foo', new Map()),
				b: v.resolveTemplate('end ${', new Map())
			};
		});
		expect(result.a.ok).toBe(false);
		expect(result.b.ok).toBe(false);
		if (!result.a.ok) expect(result.a.errorKind).toBe('malformed');
		if (!result.b.ok) expect(result.b.errorKind).toBe('malformed');
	});

	test('V13 empty string value resolves', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			const scope = new Map([['x', '']]);
			return v.resolveTemplate('a${x}b', scope);
		});
		expect(result).toMatchObject({ ok: true, text: 'ab' });
	});

	test('V14 nested value templates within maxPasses', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			const scope = new Map([
				['a', '${b}'],
				['b', 'ok']
			]);
			return v.resolveTemplate('${a}', scope);
		});
		expect(result).toMatchObject({ ok: true, text: 'ok' });
	});

	test('V14 max_passes on deep chain', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			const scope = new Map([
				['a', '${b}'],
				['b', '${c}'],
				['c', '${d}'],
				['d', '${e}'],
				['e', 'deep']
			]);
			return v.resolveTemplate('${a}', scope, { maxPasses: 3 });
		});
		// 3 passes: a->b, b->c, c->d still has ${d} or further — may hit max_passes
		// Depending on implementation: after 3 passes starting from ${a}:
		// pass1: ${b}, pass2: ${c}, pass3: ${d} — still has tokens → max_passes
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(['max_passes', 'unresolved']).toContain(result.errorKind);
		}
	});

	test('V14b no dynamic key names — prefix concat', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			const scope = new Map([['prefix', 'prod']]);
			return v.resolveTemplate('${prefix}_host', scope);
		});
		expect(result).toMatchObject({ ok: true, text: 'prod_host' });
	});

	test('V-sanitize strips dangerous and invalid', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			return v.sanitizeVariables({
				__proto__: { polluted: true },
				constructor: 'x',
				'bad-key': '1',
				ok: 'yes',
				num: 1 as unknown as string,
				arr: [] as unknown as string
			});
		});
		expect(result).toEqual({ ok: 'yes' });
	});

	test('V-slugify name spaces to underscores', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			return {
				a: v.slugifyNameForCommand('API East'),
				b: v.slugifyNameForCommand('A  B'),
				c: v.slugifyNameForCommand(''),
				ctx: v.buildContextVars({
					terminalName: 'API East',
					terminalId: 't1',
					tmuxSession: 's',
					workingDir: '/tmp/my dir',
					projectName: 'My Project',
					projectId: 'p1',
					projectGroupName: '',
					projectGroupId: '',
					connectionName: 'Prod Conn',
					connectionId: 'c1',
					connectionWsUrl: 'ws://x'
				})
			};
		});
		expect(result.a).toBe('API_East');
		expect(result.b).toBe('A__B');
		expect(result.c).toBe('');
		expect(result.ctx['terminal.name']).toBe('API_East');
		expect(result.ctx['project.name']).toBe('My_Project');
		expect(result.ctx['connection.name']).toBe('Prod_Conn');
		// workingDir not slugified
		expect(result.ctx['terminal.workingDir']).toBe('/tmp/my dir');
	});

	test('resolve user key from scope map', async ({ page }) => {
		const result = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			const layers = [{ env: 'prod' }, { port: '8080' }];
			const ctx = v.buildContextVars({
				terminalName: 't',
				terminalId: 'id',
				tmuxSession: '',
				workingDir: '',
				projectName: 'p',
				projectId: 'pid',
				projectGroupName: '',
				projectGroupId: '',
				connectionName: 'c',
				connectionId: 'cid',
				connectionWsUrl: 'ws://x'
			});
			const scope = v.buildScopeMap(layers, ctx);
			return v.resolveTemplate('deploy ${env}:${port} ${terminal.name}', scope);
		});
		expect(result).toMatchObject({ ok: true, text: 'deploy prod:8080 t' });
	});

	test('extractReferencedKeys', async ({ page }) => {
		const keys = await page.evaluate(async () => {
			const v = await import('/src/lib/variables.ts');
			return v.extractReferencedKeys('a ${env} $${x} ${terminal.name} ${bad-name}');
		});
		// malformed bad-name is not extracted as valid key
		expect(keys).toEqual(['env', 'terminal.name']);
	});
});

/**
 * Pure hierarchical variable resolution engine.
 * Must not import stores.svelte.ts (avoids cycles).
 */

export type NodeVariables = Record<string, string>;

export type ResolveErrorKind = 'unresolved' | 'malformed' | 'max_passes';

export type ResolveResult =
	| { ok: true; text: string; usedKeys: string[] }
	| {
			ok: false;
			error: string;
			errorKind: ResolveErrorKind;
			unresolved: string[];
			malformed?: string;
		};

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Valid user variable key: bare identifier only (no dots). */
export function isValidUserKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Valid token key inside ${…}: bare or dotted segments (context keys). */
export function isValidTokenKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(key);
}

export function isDangerousKey(key: string): boolean {
	return DANGEROUS_KEYS.has(key);
}

/**
 * Coerce unknown JSON into a safe NodeVariables map.
 */
export function sanitizeVariables(input: unknown): NodeVariables {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
	const out: NodeVariables = {};
	for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
		if (DANGEROUS_KEYS.has(k)) continue;
		if (!isValidUserKey(k)) continue;
		if (typeof v !== 'string') continue;
		out[k] = v;
	}
	return out;
}

/** Replace each ASCII space with `_` for command-safe display names (K20a). */
export function slugifyNameForCommand(name: string): string {
	return name.replaceAll(' ', '_');
}

/** Fields required to build context vars — structural, not store classes. */
export interface ContextSource {
	terminalName: string;
	terminalId: string;
	tmuxSession: string;
	workingDir: string;
	projectName: string;
	projectId: string;
	projectGroupName: string;
	projectGroupId: string;
	connectionName: string;
	connectionId: string;
	connectionWsUrl: string;
}

/** @deprecated use ContextSource */
export type SystemContext = ContextSource;

export function buildContextVars(ctx: ContextSource): Record<string, string> {
	return {
		'terminal.name': slugifyNameForCommand(ctx.terminalName ?? ''),
		'terminal.id': ctx.terminalId ?? '',
		'terminal.tmuxSession': ctx.tmuxSession ?? '',
		'terminal.workingDir': ctx.workingDir ?? '',
		'project.name': slugifyNameForCommand(ctx.projectName ?? ''),
		'project.id': ctx.projectId ?? '',
		'projectGroup.name': slugifyNameForCommand(ctx.projectGroupName ?? ''),
		'projectGroup.id': ctx.projectGroupId ?? '',
		'connection.name': slugifyNameForCommand(ctx.connectionName ?? ''),
		'connection.id': ctx.connectionId ?? '',
		'connection.wsUrl': ctx.connectionWsUrl ?? ''
	};
}

/** Merge user layers low→high priority, then context (highest). */
export function buildScopeMap(
	layers: NodeVariables[],
	context: Record<string, string>
): Map<string, string> {
	const map = new Map<string, string>();
	for (const layer of layers) {
		for (const [k, v] of Object.entries(layer)) {
			if (isValidUserKey(k)) map.set(k, v);
		}
	}
	for (const [k, v] of Object.entries(context)) {
		map.set(k, v);
	}
	return map;
}

const KEY_BODY = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/;

/** Private-use sentinel so escaped `${` is not re-tokenized on later passes. */
const ESCAPED_DOLLAR_BRACE = '\uE000';

type ScanPassResult =
	| { ok: true; text: string; usedKeys: string[]; hasTokens: boolean }
	| {
			ok: false;
			errorKind: 'malformed' | 'unresolved';
			error: string;
			unresolved: string[];
			malformed?: string;
		};

/**
 * One left-to-right scan pass with strict fail-closed token rules.
 */
function scanPass(template: string, scope: Map<string, string>): ScanPassResult {
	let out = '';
	const usedKeys: string[] = [];
	const missing = new Set<string>();
	let hasTokens = false;
	let i = 0;

	while (i < template.length) {
		if (template.slice(i, i + 3) === '$${') {
			// Keep as sentinel until final resolve so multipass won't re-parse as a token
			out += ESCAPED_DOLLAR_BRACE;
			i += 3;
			continue;
		}

		if (template[i] === '$' && template[i + 1] === '{') {
			const afterBrace = template.slice(i + 2);
			const m = afterBrace.match(KEY_BODY);
			if (!m) {
				// Unclosed or invalid name — capture a short snippet for the error
				const snippetEnd = Math.min(template.length, i + 24);
				const snippet = template.slice(i, snippetEnd);
				return {
					ok: false,
					errorKind: 'malformed',
					error: `Malformed variable token: ${snippet}`,
					unresolved: [],
					malformed: snippet
				};
			}
			const key = m[1];
			const tokenLen = 2 + m[0].length; // ${ + key + }
			hasTokens = true;
			if (!scope.has(key)) {
				missing.add(key);
				// Keep the original token text when missing so multi-pass reporting is clear;
				// we fail after the pass when missing is non-empty.
				out += template.slice(i, i + tokenLen);
			} else {
				out += scope.get(key)!;
				usedKeys.push(key);
			}
			i += tokenLen;
			continue;
		}

		out += template[i];
		i += 1;
	}

	if (missing.size > 0) {
		const unresolved = [...missing];
		return {
			ok: false,
			errorKind: 'unresolved',
			error: `Unresolved variable(s): ${unresolved.join(', ')}`,
			unresolved
		};
	}

	return { ok: true, text: out, usedKeys, hasTokens };
}

/**
 * Detect whether a string still contains variable token candidates
 * (valid ${key} or malformed ${ that isn't an escape).
 */
export function hasVariableCandidates(template: string): boolean {
	let i = 0;
	while (i < template.length) {
		if (template.slice(i, i + 3) === '$${') {
			i += 3;
			continue;
		}
		if (template[i] === '$' && template[i + 1] === '{') {
			return true;
		}
		i += 1;
	}
	return false;
}

/**
 * Resolve a template against a scope map with multi-pass expansion (maxPasses default 3).
 */
function finalizeEscapes(text: string): string {
	return text.replaceAll(ESCAPED_DOLLAR_BRACE, '${');
}

export function resolveTemplate(
	template: string,
	scope: Map<string, string>,
	opts?: { maxPasses?: number }
): ResolveResult {
	const maxPasses = opts?.maxPasses ?? 3;
	let current = template;
	const allUsed: string[] = [];

	for (let pass = 1; pass <= maxPasses; pass++) {
		const result = scanPass(current, scope);
		if (!result.ok) {
			return {
				ok: false,
				error: result.error,
				errorKind: result.errorKind,
				unresolved: result.unresolved,
				malformed: result.malformed
			};
		}
		allUsed.push(...result.usedKeys);
		current = result.text;

		if (!hasVariableCandidates(current)) {
			return {
				ok: true,
				text: finalizeEscapes(current),
				usedKeys: [...new Set(allUsed)]
			};
		}

		// Tokens remain (values introduced new refs). Continue if passes remain.
		if (pass === maxPasses) {
			// Final attempt: try one more scan to surface unresolved vs still looping
			const last = scanPass(current, scope);
			if (!last.ok) {
				return {
					ok: false,
					error: last.error,
					errorKind: last.errorKind,
					unresolved: last.unresolved,
					malformed: last.malformed
				};
			}
			if (!hasVariableCandidates(last.text)) {
				allUsed.push(...last.usedKeys);
				return {
					ok: true,
					text: finalizeEscapes(last.text),
					usedKeys: [...new Set(allUsed)]
				};
			}
			return {
				ok: false,
				error: 'Variable expansion exceeded max passes (3)',
				errorKind: 'max_passes',
				unresolved: extractReferencedKeys(last.text).filter((k) => !scope.has(k))
			};
		}
	}

	return {
		ok: false,
		error: 'Variable expansion exceeded max passes (3)',
		errorKind: 'max_passes',
		unresolved: []
	};
}

/**
 * Extract well-formed ${key} references from a template (ignores escapes / malformed).
 */
export function extractReferencedKeys(template: string): string[] {
	const keys: string[] = [];
	let i = 0;
	while (i < template.length) {
		if (template.slice(i, i + 3) === '$${') {
			i += 3;
			continue;
		}
		if (template[i] === '$' && template[i + 1] === '{') {
			const afterBrace = template.slice(i + 2);
			const m = afterBrace.match(KEY_BODY);
			if (!m) {
				// skip past ${ and continue (malformed — don't count)
				i += 2;
				continue;
			}
			keys.push(m[1]);
			i += 2 + m[0].length;
			continue;
		}
		i += 1;
	}
	return keys;
}

/**
 * Count well-formed references to a specific key in a template string.
 */
export function countKeyReferences(template: string, key: string): number {
	return extractReferencedKeys(template).filter((k) => k === key).length;
}

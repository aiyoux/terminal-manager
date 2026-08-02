/**
 * Pure helpers for command text replacement (literal, case-sensitive).
 * Must not import stores.svelte.ts.
 */

/**
 * Apply a single literal find/replace to a command string.
 * @param replaceAll when true, all non-overlapping left-to-right occurrences.
 */
export function applyLiteralReplace(
	text: string,
	find: string,
	replace: string,
	replaceAll: boolean
): string {
	if (!find) return text;
	if (!replaceAll) {
		const idx = text.indexOf(find);
		if (idx === -1) return text;
		return text.slice(0, idx) + replace + text.slice(idx + find.length);
	}
	// split/join is fine for non-overlapping literal replace
	return text.split(find).join(replace);
}

/** Count non-overlapping literal occurrences of find in text. */
export function countLiteralOccurrences(text: string, find: string): number {
	if (!find) return 0;
	let count = 0;
	let from = 0;
	while (from <= text.length) {
		const idx = text.indexOf(find, from);
		if (idx === -1) break;
		count += 1;
		from = idx + find.length;
	}
	return count;
}

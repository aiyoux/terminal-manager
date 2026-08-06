/**
 * Drag-and-drop helpers for the sidebar tree. Pure functions + types only — no
 * runes, no DOM state — so they're trivial to test. The reactive drag/drop
 * state lives in the consumer (`+page.svelte`) because there is a single tree.
 *
 * Semantics ported from modular-app's `item-tree` package (RecordTreeView):
 * three-zone drops (before / into / after) computed from the cursor's vertical
 * position within the hovered row, a hybrid mouse-HTML5 + touch/pointer input
 * model, and an interactive-target guard so inner controls don't start drags.
 * Adapted to this app's typed hierarchy (connection → project-group → project
 * → terminal → command, plus terminal-group → group-terminal); the commit
 * layer is the existing `reorder*` / `move*` store functions.
 */

export type DragType =
  | 'connection'
  | 'project'
  | 'project-group'
  | 'terminal'
  | 'command'
  | 'group'
  | 'group-terminal';

export type Zone = 'before' | 'after' | 'into';

export interface DragState {
  type: DragType;
  id: string;
  index: number;
  connId?: string;
  projectId?: string;
  terminalId?: string;
  groupId?: string;
}

export interface DropState {
  targetType: DragType;
  targetId: string;
  targetIndex: number;
  zone: Zone;
  connId?: string;
  groupId?: string;
  projectId?: string;
  terminalId?: string;
}

/**
 * Selector matching elements that should NOT start a drag (their own click
 * handlers still fire). CRITICAL: this must NOT include `button` or
 * `[role="button"]` — the row bar itself is a `<button>` and must remain a drag
 * source. Only the action-icon cluster and chevron are marked `data-no-drag`.
 */
export const GUARD_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="checkbox"], [data-no-drag]';

export function isInteractiveDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(GUARD_SELECTOR));
}

/** Pass to `move*` store functions to append to the end of the target list. */
export const APPEND = Number.MAX_SAFE_INTEGER;

/**
 * Map cursor Y to a drop zone, restricted to the zones the (drag, target)
 * pair actually allows. This tree never has a case that allows all three
 * zones simultaneously — `before`/`after` are sibling-only and `into` is
 * container-only — so we only need the two branches below.
 */
export function pickZone(rect: DOMRect, clientY: number, allowed: Zone[]): Zone | null {
  if (allowed.length === 0) return null;
  if (allowed.length === 1) return allowed[0];
  const y = clientY - rect.top;
  // Sibling reorder: top half = before, bottom half = after.
  return y < rect.height / 2 ? 'before' : 'after';
}

/**
 * Which zones are legal for the dragged item over this target. Returns `[]`
 * when the drop is forbidden (the caller then skips `preventDefault`, so the
 * browser won't allow a drop and no indicator shows).
 *
 * `over` carries the target's type plus the container ids needed to enforce
 * same-container constraints for the two reorder functions that have no
 * cross-container API: `reorderProjectGroups` (same connection) and
 * `reorderGroupTerminals` (same group).
 */
export function allowedZones(
  drag: DragState,
  over: { targetType: DragType; connId?: string; groupId?: string }
): Zone[] {
  const dt = drag.type;
  const tt = over.targetType;

  // Same-type sibling reorder (before/after only). project-group and
  // group-terminal are further constrained to the same container below.
  if (dt === tt) {
    if (dt === 'project-group' && drag.connId !== over.connId) return [];
    if (dt === 'group-terminal' && drag.groupId !== over.groupId) return [];
    return ['before', 'after'];
  }

  // Container drops (into only): move a child into a container of its kind.
  if (dt === 'project' && (tt === 'connection' || tt === 'project-group')) return ['into'];
  if (dt === 'terminal' && tt === 'project') return ['into'];
  if (dt === 'command' && tt === 'terminal') return ['into'];

  return [];
}

/**
 * Post-removal insertion index for a same-list sibling reorder, validated
 * against `moveItem`'s `if (toIndex < 0 || toIndex > arr.length) return`
 * guard (which checks `toIndex` against the ORIGINAL pre-splice length).
 *
 * For non-self drops the result always falls in `[0, n-1]`, so the guard never
 * trips. The identity guard (caller) is what makes "drop onto self" a no-op —
 * on its own this formula would *move* a row after itself.
 */
export function insertIndex(from: number, target: number, zone: Zone): number {
  // Same element: caller's identity guard prevents this; bail defensively.
  if (from === target) return from;
  // Index of the target element in the array AFTER the source is removed.
  const finalTarget = from < target ? target - 1 : target;
  return zone === 'before' ? finalTarget : finalTarget + 1;
}
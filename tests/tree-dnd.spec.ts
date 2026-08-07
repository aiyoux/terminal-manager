import { test, expect } from '@playwright/test';

/**
 * Coverage for the pure drag/drop helpers in `src/lib/tree-dnd.ts` — the
 * three-zone model, the compatibility matrix, the sibling-insert math (which
 * fixed a pre-existing off-by-one where downward same-list drops landed after
 * the target), and the interactive-target guard (which must NOT block the bar
 * button itself, only `data-no-drag` / form controls).
 *
 * These are pure functions exercised in-browser via dynamic import, so they're
 * deterministic and don't depend on flaky HTML5 drag dispatch.
 */
test.describe('tree-dnd helpers', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate so in-page dynamic imports resolve against the Vite origin
    // (otherwise the page is at about:blank and import() can't resolve).
    await page.goto('/');
  });

  test('insertIndex: same-list sibling reorder lands before/after the target', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { insertIndex } = await import('/src/lib/tree-dnd.ts');
      return {
        // Drag item 0 to before index 2 -> after removing item 0 the target
        // shifts to 1, so 'before' lands at 1 (not 2). This is the off-by-one
        // that previously made downward same-list drops land AFTER the target.
        downBefore: insertIndex(0, 2, 'before'),
        downAfter: insertIndex(0, 2, 'after'),
        // Drag item 2 to before/after index 0 -> source is after target, so the
        // target doesn't shift; before -> 0, after -> 1.
        upBefore: insertIndex(2, 0, 'before'),
        upAfter: insertIndex(2, 0, 'after'),
        // Self drop is a no-op handled by the caller's identity guard; the
        // formula returns the original index defensively.
        self: insertIndex(3, 3, 'before'),
      };
    });
    expect(result.downBefore).toBe(1);
    expect(result.downAfter).toBe(2);
    expect(result.upBefore).toBe(0);
    expect(result.upAfter).toBe(1);
    expect(result.self).toBe(3);
  });

  test('pickZone: top/bottom half for siblings; single allowed zone passes through', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { pickZone } = await import('/src/lib/tree-dnd.ts');
      const rect = { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON() { return {}; } } as DOMRect;
      return {
        topHalf: pickZone(rect, 5, ['before', 'after']),
        bottomHalf: pickZone(rect, 15, ['before', 'after']),
        intoOnly: pickZone(rect, 5, ['into']),
        none: pickZone(rect, 5, []),
        // Expanded nested content under a row header must force "after" so open
        // terminal command lists don't trap drops in the geometric top-half.
        expandedBelow: pickZone(rect, 5, ['before', 'after'], { expandedBelow: true }),
        expandedIntoOnly: pickZone(rect, 5, ['into'], { expandedBelow: true }),
      };
    });
    expect(result.topHalf).toBe('before');
    expect(result.bottomHalf).toBe('after');
    expect(result.intoOnly).toBe('into');
    expect(result.none).toBeNull();
    expect(result.expandedBelow).toBe('after');
    expect(result.expandedIntoOnly).toBe('into');
  });

  test('allowedZones: container into-drops, sibling reorders, and forbidden pairs', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { allowedZones } = await import('/src/lib/tree-dnd.ts');
      const project = { type: 'project' as const, id: 'p', index: 0, connId: 'c' };
      const terminal = { type: 'terminal' as const, id: 't', index: 0, connId: 'c', projectId: 'p' };
      const command = { type: 'command' as const, id: 'k', index: 0, terminalId: 't' };
      const pgA = { type: 'project-group' as const, id: 'g1', index: 0, connId: 'c', groupId: 'g1' };
      const pgB = { type: 'project-group' as const, id: 'g2', index: 0, connId: 'c2', groupId: 'g2' };
      const gtA = { type: 'group-terminal' as const, id: 'x', index: 0, terminalId: 'x', groupId: 'grp' };
      const gtB = { type: 'group-terminal' as const, id: 'x2', index: 0, terminalId: 'x2', groupId: 'other' };
      return {
        projectIntoConn: allowedZones(project, { targetType: 'connection' }),
        projectIntoGroup: allowedZones(project, { targetType: 'project-group', connId: 'c' }),
        terminalIntoProject: allowedZones(terminal, { targetType: 'project' }),
        commandIntoTerminal: allowedZones(command, { targetType: 'terminal' }),
        connReorder: allowedZones({ type: 'connection', id: 'c2', index: 0 }, { targetType: 'connection' }),
        pgSameConn: allowedZones(pgA, { targetType: 'project-group', connId: 'c' }),
        pgDiffConn: allowedZones(pgB, { targetType: 'project-group', connId: 'c' }),
        gtSameGroup: allowedZones(gtA, { targetType: 'group-terminal', groupId: 'grp' }),
        gtDiffGroup: allowedZones(gtB, { targetType: 'group-terminal', groupId: 'grp' }),
        // Forbidden pairs — no shared container relationship.
        projectOverTerminal: allowedZones(project, { targetType: 'terminal' }),
        terminalOverConnection: allowedZones(terminal, { targetType: 'connection' }),
        commandOverProject: allowedZones(command, { targetType: 'project' }),
      };
    });
    expect(r.projectIntoConn).toEqual(['into']);
    expect(r.projectIntoGroup).toEqual(['into']);
    expect(r.terminalIntoProject).toEqual(['into']);
    expect(r.commandIntoTerminal).toEqual(['into']);
    expect(r.connReorder).toEqual(['before', 'after']);
    expect(r.pgSameConn).toEqual(['before', 'after']);
    expect(r.pgDiffConn).toEqual([]);
    expect(r.gtSameGroup).toEqual(['before', 'after']);
    expect(r.gtDiffGroup).toEqual([]);
    expect(r.projectOverTerminal).toEqual([]);
    expect(r.terminalOverConnection).toEqual([]);
    expect(r.commandOverProject).toEqual([]);
  });

  test('isInteractiveDragTarget: guards data-no-drag and form controls, NOT button rows', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { isInteractiveDragTarget } = await import('/src/lib/tree-dnd.ts');
      const make = (html: string) => {
        const el = document.createElement('div');
        el.innerHTML = html;
        return el.firstElementChild as Element;
      };
      // The bar row IS a <button> and must remain a drag source.
      const button = make('<button>row</button>');
      const noDrag = make('<div data-no-drag></div>');
      const input = make('<input />');
      const checkbox = make('<div role="checkbox"></div>');
      // Closest() walks up: a span inside a [data-no-drag] container is guarded.
      const spanInNoDrag = make('<div data-no-drag><span>x</span></div>')?.querySelector('span');
      return {
        button: isInteractiveDragTarget(button),
        noDrag: isInteractiveDragTarget(noDrag),
        input: isInteractiveDragTarget(input),
        checkbox: isInteractiveDragTarget(checkbox),
        spanInNoDrag: isInteractiveDragTarget(spanInNoDrag),
        null: isInteractiveDragTarget(null),
      };
    });
    expect(r.button).toBe(false); // CRITICAL: rows are buttons and must drag
    expect(r.noDrag).toBe(true);
    expect(r.input).toBe(true);
    expect(r.checkbox).toBe(true);
    expect(r.spanInNoDrag).toBe(true);
    expect(r.null).toBe(false);
  });
});
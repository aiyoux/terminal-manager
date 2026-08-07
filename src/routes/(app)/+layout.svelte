<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import Terminal from '$lib/components/Terminal.svelte';
  import VariablesEditor from '$lib/components/VariablesEditor.svelte';
  import TextReplaceModal from '$lib/components/TextReplaceModal.svelte';
  import { closeConnection, sendInput, isConnected, reconnectConnection, connectionStatuses } from '$lib/connectionManager.svelte';

  let { children } = $props();
  import {
    getConnections,
    getTerminalGroups,
    getActiveTerminalId,
    setActiveTerminalId,
    addConnection,
    removeConnection,
    toggleConnectionCollapse,
    addProject,
    removeProject,
    toggleProjectCollapse,
    addProjectGroup,
    removeProjectGroup,
    renameProjectGroup,
    toggleProjectGroupCollapse,
    reorderProjectGroups,
    moveProject,
    findProjectById,
    addTerminal,
    duplicateTerminal,
    removeTerminal,
    toggleTerminalCollapse,
    toggleTerminalGridHidden,
    addSavedCommand,
    duplicateSavedCommand,
    removeSavedCommand,
    updateSavedCommand,
    toggleCommandOnConnect,
    toggleCommandAutoExecute,
    toggleCommandCtrlCBefore,
    getWsUrlForTerminal,
    findTerminalById,
    isLoaded,
    exportState,
    importState,
    reorderConnections,
    reorderProjects,
    reorderTerminals,
    moveTerminal,
    reorderSavedCommands,
    moveSavedCommand,
    addTerminalGroup,
    removeTerminalGroup,
    toggleGroupCollapse,
    addTerminalToGroup,
    removeTerminalFromGroup,
    reorderGroups,
    reorderGroupTerminals,
    duplicateConnection,
    duplicateProject,
    duplicateProjectGroup,
    duplicateTerminalTo,
    duplicateSavedCommandTo,
    duplicateGroup,
    copyTerminalToGroup,
    getGridSettings,
    setGridLayout,
    toggleTerminalPinned,
    resolveCommandForTerminal,
    lastOnConnectErrors,
    type Connection,
    type Project,
    type ProjectGroup,
    type TerminalTab,
    type SavedCommand,
    type TerminalGroup,
    type VariableOwnerRef,
  } from '$lib/stores.svelte';
  import {
    APPEND,
    allowedZones,
    insertIndex,
    isInteractiveDragTarget,
    pickZone,
    type DragState,
    type DragType,
    type DropState,
    type Zone,
  } from '$lib/tree-dnd';

  let connections = $derived(getConnections());
  let terminalGroups = $derived(getTerminalGroups());
  let activeTerminalId = $derived(getActiveTerminalId());
  let activeWsUrl = $derived(getWsUrlForTerminal(activeTerminalId));

  type SidebarTab = 'connections' | 'groups' | 'pinned';

  /** Driven by the URL so refresh keeps the active sidebar tab. */
  let activeSidebarTab = $derived.by((): SidebarTab => {
    const path = page.url.pathname;
    if (path === '/groups' || path.startsWith('/groups/')) return 'groups';
    if (path === '/pinned' || path.startsWith('/pinned/')) return 'pinned';
    return 'connections';
  });

  // --- Sidebar view settings ---
  const VIEW_SETTINGS_KEY = 'terminal-dashboard-view-settings';
  /** When true, show auto-run / hit-enter / ctrl+c icons on command rows in the tree. Default hidden. */
  let showCommandActionIcons = $state(false);

  function setShowCommandActionIcons(value: boolean) {
    showCommandActionIcons = value;
    try {
      localStorage.setItem(VIEW_SETTINGS_KEY, JSON.stringify({ showCommandActionIcons: value }));
    } catch {
      // ignore
    }
  }

  // --- Row click vs. drag ---
  // Single-click anywhere on a row bar toggles its collapse (or selects a
  // terminal), but a press that turns into a drag (reorder) must NOT fire that
  // click action. Track the pointer-down position and, on click, treat anything
  // that moved more than this many pixels as a drag, not a click.
  const ROW_DRAG_THRESHOLD = 6;
  let rowPressXY: { x: number; y: number } | null = null;

  function onRowPointerDown(e: PointerEvent) {
    rowPressXY = { x: e.clientX, y: e.clientY };
  }

  /** Run `action` only for a clean click — a press that moved (a drag/reorder)
   *  is ignored. Keyboard activation (Enter, `e.detail === 0`) always runs. */
  function onRowClick(e: MouseEvent, action: () => void) {
    // A touch/pen drag just committed a drop — suppress the synthetic click it
    // raises (some browsers fire it with e.detail === 0, bypassing the
    // distance check below).
    if (pointerDragCommitted) {
      pointerDragCommitted = false;
      return;
    }
    const press = rowPressXY;
    rowPressXY = null;
    if (press && e.detail > 0) {
      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (moved > ROW_DRAG_THRESHOLD) return; // was a drag, not a click
    }
    action();
  }

  // Restore view settings once on client
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(VIEW_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { showCommandActionIcons?: boolean };
        if (typeof parsed.showCommandActionIcons === 'boolean') {
          showCommandActionIcons = parsed.showCommandActionIcons;
        }
      }
    } catch {
      // ignore
    }
  }

  // --- Drag and Drop ---
  // Three-zone (before / into / after) DnD via pointer events for all input
  // types (mouse, touch, pen). Semantics ported from modular-app's item-tree;
  // commit layer is the existing reorder*/move* store functions.
  type RowDescriptor = {
    type: DragType;
    id: string;
    index: number;
    connId?: string;
    projectId?: string;
    terminalId?: string;
    groupId?: string;
    /** True for the synthetic end-of-list "append here" zone — it has no row
     *  of its own, so the pointer path treats it as a virtual final
     *  sibling that always drops `after` (i.e. appends to the list). */
    append?: boolean;
  };

  // Drag bookkeeping is plain JS + DOM paints — NOT $state — so pointermove
  // never re-renders +page (and all xterms). Only the final commit mutates stores.
  let pointerDragCommitted = false;
  let stopPointerDrag: (() => void) | null = null;
  let copyBadgeEl: HTMLElement | null = null;
  let liveDrop: DropState | null = null;
  let liveDropEl: HTMLElement | null = null;
  let dragSourceEl: HTMLElement | null = null;
  /** True while a tree drag is active (for workspace pointer-events). DOM-driven. */
  let treeDragActive = false;

  const ZONE_CLASSES = ['dnd-zone-before', 'dnd-zone-after', 'dnd-zone-into'] as const;

  function clearDropPaint() {
    if (liveDropEl) {
      liveDropEl.classList.remove(...ZONE_CLASSES);
      liveDropEl = null;
    }
    liveDrop = null;
  }

  function paintDrop(el: HTMLElement | null, drop: DropState | null) {
    if (
      liveDropEl === el &&
      ((liveDrop === null && drop === null) ||
        (liveDrop &&
          drop &&
          liveDrop.targetType === drop.targetType &&
          liveDrop.targetId === drop.targetId &&
          liveDrop.targetIndex === drop.targetIndex &&
          liveDrop.zone === drop.zone &&
          liveDrop.connId === drop.connId &&
          liveDrop.groupId === drop.groupId &&
          liveDrop.projectId === drop.projectId &&
          liveDrop.terminalId === drop.terminalId))
    ) {
      return;
    }
    if (liveDropEl && liveDropEl !== el) {
      liveDropEl.classList.remove(...ZONE_CLASSES);
    } else if (liveDropEl && liveDropEl === el) {
      liveDropEl.classList.remove(...ZONE_CLASSES);
    }
    liveDrop = drop;
    liveDropEl = el;
    if (el && drop) el.classList.add(`dnd-zone-${drop.zone}`);
  }

  function setTreeDragActive(active: boolean) {
    treeDragActive = active;
    document.body.classList.toggle('tree-dnd-active', active);
    if (workspaceEl) workspaceEl.classList.toggle('pointer-events-none', active || isResizingSidebar);
  }

  function expandConnection(connId: string) {
    if (connections.find((c) => c.id === connId)?.collapsed) toggleConnectionCollapse(connId);
  }
  function expandProjectGroup(connId: string, groupId: string) {
    const g = connections.find((c) => c.id === connId)?.projectGroups?.find((g) => g.id === groupId);
    if (g?.collapsed) toggleProjectGroupCollapse(connId, groupId);
  }
  function expandProject(_connId: string, projectId: string) {
    if (findProjectById(projectId)?.project.collapsed) toggleProjectCollapse(_connId, projectId);
  }
  function expandTerminal(_connId: string, _projectId: string, terminalId: string) {
    if (findTerminalById(terminalId)?.terminal.collapsed)
      toggleTerminalCollapse(_connId, _projectId, terminalId);
  }

  /** Commit the current drag onto its drop target. */
  function commitDrop(drag: DragState, over: DropState | null, copy: boolean) {
    if (!drag || !over) return;

    // Identity guard — "drop onto self" is a no-op. Commands are scoped by
    // terminal and group-terminals by group, since the same id can appear in
    // more than one container. (In copy mode, self-drop in the same container
    // is still allowed — it creates a duplicate right next to the original.)
    if (
      !copy &&
      drag.id === over.targetId &&
      drag.type === over.targetType &&
      (drag.type !== 'command' || drag.terminalId === over.terminalId) &&
      (drag.type !== 'group-terminal' || drag.groupId === over.groupId)
    ) {
      return;
    }

    const zone = over.zone;
    switch (drag.type) {
      case 'connection':
        if (over.targetType === 'connection') {
          const toIndex = insertIndex(drag.index, over.targetIndex, zone);
          if (copy)
            duplicateConnection(drag.id, toIndex, true);
          else
            reorderConnections(drag.index, toIndex);
        }
        break;
      case 'project':
        if (over.targetType === 'project') {
          const sameContainer =
            drag.connId === over.connId && drag.groupId === over.groupId;
          const toIndex = sameContainer
            ? insertIndex(drag.index, over.targetIndex, zone)
            : zone === 'before'
              ? over.targetIndex
              : over.targetIndex + 1;
          if (copy)
            duplicateProject(drag.id, over.connId!, over.groupId ?? null, toIndex, sameContainer);
          else
            moveProject(drag.id, over.connId!, over.groupId ?? null, toIndex);
        } else if (over.targetType === 'connection') {
          if (copy)
            duplicateProject(drag.id, over.targetId, null, APPEND, false);
          else {
            moveProject(drag.id, over.targetId, null, APPEND);
            expandConnection(over.targetId);
          }
        } else if (over.targetType === 'project-group') {
          if (copy)
            duplicateProject(drag.id, over.connId!, over.targetId, APPEND, false);
          else {
            moveProject(drag.id, over.connId!, over.targetId, APPEND);
            expandProjectGroup(over.connId!, over.targetId);
          }
        }
        break;
      case 'project-group':
        if (over.targetType === 'project-group') {
          const toIndex = insertIndex(drag.index, over.targetIndex, zone);
          if (copy)
            duplicateProjectGroup(drag.connId!, drag.id, toIndex, true);
          else
            reorderProjectGroups(drag.connId!, drag.index, toIndex);
        }
        break;
      case 'terminal':
        if (over.targetType === 'terminal') {
          if (drag.projectId === over.projectId) {
            const toIndex = insertIndex(drag.index, over.targetIndex, zone);
            if (copy)
              duplicateTerminalTo(drag.id, over.projectId!, toIndex, true);
            else
              reorderTerminals(drag.connId!, drag.projectId!, drag.index, toIndex);
          } else {
            const toIndex = zone === 'before' ? over.targetIndex : over.targetIndex + 1;
            if (copy)
              duplicateTerminalTo(drag.id, over.projectId!, toIndex, false);
            else
              moveTerminal(drag.id, over.projectId!, toIndex);
          }
        } else if (over.targetType === 'project') {
          if (copy)
            duplicateTerminalTo(drag.id, over.targetId, APPEND, false);
          else {
            moveTerminal(drag.id, over.targetId, APPEND);
            expandProject(over.connId!, over.targetId);
          }
        }
        break;
      case 'command':
        if (over.targetType === 'command') {
          const sameTerminal = drag.terminalId === over.terminalId;
          const toIndex = sameTerminal
            ? insertIndex(drag.index, over.targetIndex, zone)
            : zone === 'before'
              ? over.targetIndex
              : over.targetIndex + 1;
          if (copy)
            duplicateSavedCommandTo(drag.terminalId!, drag.id, over.terminalId!, toIndex, sameTerminal);
          else
            moveSavedCommand(drag.terminalId!, over.terminalId!, drag.id, toIndex);
        } else if (over.targetType === 'terminal') {
          if (copy)
            duplicateSavedCommandTo(drag.terminalId!, drag.id, over.targetId, APPEND, false);
          else {
            moveSavedCommand(drag.terminalId!, over.targetId, drag.id, APPEND);
            expandTerminal(over.connId!, over.projectId!, over.targetId);
          }
        }
        break;
      case 'group':
        if (over.targetType === 'group') {
          const toIndex = insertIndex(drag.index, over.targetIndex, zone);
          if (copy)
            duplicateGroup(drag.id, toIndex, true);
          else
            reorderGroups(drag.index, toIndex);
        }
        break;
      case 'group-terminal':
        if (over.targetType === 'group-terminal') {
          if (copy) {
            // Can't duplicate a terminal reference within the same group.
            if (drag.groupId !== over.groupId)
              copyTerminalToGroup(drag.id, over.groupId!, insertIndex(drag.index, over.targetIndex, zone));
          } else {
            reorderGroupTerminals(drag.groupId!, drag.index, insertIndex(drag.index, over.targetIndex, zone));
          }
        }
        break;
    }
  }

  // --- Pointer drag path (mouse / touch / pen) ---
  // All input types go through pointer events. A movement threshold gates
  // activation so a plain click doesn't flicker the dragged styling or commit
  // a drop, and — critically — so the browser still fires a normal click after
  // a slightly-draggy press (the old native-HTML5-drag path suppressed clicks
  // once the cursor drifted past the browser's ~3px drag threshold, which made
  // tapping a small label feel dead). No setPointerCapture — it would steal the
  // bar button's tap-to-toggle click.

  function rowFromPoint(x: number, y: number): HTMLElement | null {
    return document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-dnd-row]') ?? null;
  }

  /** Walk up from `el` to the nearest `[data-dnd-row]` ancestor (skipping
   *  `el` itself). Returns null at the top of the tree. */
  function parentDndRow(el: HTMLElement): HTMLElement | null {
    return el.parentElement?.closest<HTMLElement>('[data-dnd-row]') ?? null;
  }

  /** Header bar for zone math. Expanded children (commands, nested projects)
   *  must not stretch the before/after split — only the bar does. */
  function dndBarRect(row: HTMLElement): DOMRect {
    const bar = row.querySelector<HTMLElement>(':scope > [data-dnd-bar]');
    return (bar ?? row).getBoundingClientRect();
  }

  function descriptorFromDataset(el: HTMLElement): RowDescriptor | null {
    const ds = el.dataset;
    if (!ds.dndType || !ds.dndId) return null;
    return {
      type: ds.dndType as DragType,
      id: ds.dndId,
      index: Number(ds.dndIndex ?? '0'),
      connId: ds.dndConn || undefined,
      groupId: ds.dndGroup || undefined,
      projectId: ds.dndProject || undefined,
      terminalId: ds.dndTerminal || undefined,
      append: ds.dndAppend === '1',
    };
  }

  function isSelfDrop(drag: RowDescriptor | DragState, over: RowDescriptor): boolean {
    return (
      over.type === drag.type &&
      over.id === drag.id &&
      (over.type !== 'command' || over.terminalId === drag.terminalId) &&
      (over.type !== 'group-terminal' || over.groupId === drag.groupId)
    );
  }

  function positionCopyBadge(x: number, y: number, show: boolean) {
    const el = copyBadgeEl;
    if (!el) return;
    if (!show) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    el.style.left = `${x + 12}px`;
    el.style.top = `${y - 22}px`;
  }

  function onPointerDown(e: PointerEvent, desc: RowDescriptor) {
    pointerDragCommitted = false; // fresh for this gesture
    if (e.button !== 0) return; // only primary button drags
    if (isInteractiveDragTarget(e.target)) return;
    e.stopPropagation(); // prevent nested wrappers starting a second session

    let activated = false;
    let liveCopy = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const sourceEl = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    const drag: DragState = {
      type: desc.type,
      id: desc.id,
      index: desc.index,
      connId: desc.connId,
      projectId: desc.projectId,
      terminalId: desc.terminalId,
      groupId: desc.groupId,
    };

    const move = (ev: PointerEvent) => {
      if (!activated) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= ROW_DRAG_THRESHOLD) return;
        activated = true;
        pointerDragCommitted = true;
        dragSourceEl = sourceEl;
        sourceEl?.classList.add('dnd-dragging');
        setTreeDragActive(true);
      }

      const nextCopy = ev.shiftKey;
      if (nextCopy !== liveCopy) liveCopy = nextCopy;
      positionCopyBadge(ev.clientX, ev.clientY, liveCopy);

      // Walk up from the innermost data-dnd-row to find a compatible target.
      // When the accepting row is an ancestor (pointer in expanded children),
      // force zone `after` so open command lists don't trap drops as "before".
      const hitEl = rowFromPoint(ev.clientX, ev.clientY);
      let el: HTMLElement | null = hitEl;
      let t = el && descriptorFromDataset(el);
      let walkedUp = false;
      if (t) {
        let self = !liveCopy && isSelfDrop(drag, t);
        let allowed = self ? [] : allowedZones(drag, { targetType: t.type, connId: t.connId, groupId: t.groupId });
        while ((self || allowed.length === 0) && el) {
          el = parentDndRow(el);
          walkedUp = true;
          t = el && descriptorFromDataset(el);
          if (!t) break;
          self = !liveCopy && isSelfDrop(drag, t);
          allowed = self ? [] : allowedZones(drag, { targetType: t.type, connId: t.connId, groupId: t.groupId });
        }
      }
      if (!t || !el) {
        paintDrop(null, null);
        return;
      }
      if (!liveCopy && isSelfDrop(drag, t)) {
        paintDrop(null, null);
        return;
      }
      const allowed = allowedZones(drag, { targetType: t.type, connId: t.connId, groupId: t.groupId });
      if (allowed.length === 0) {
        paintDrop(null, null);
        return;
      }
      let zone: Zone | null;
      if (t.append) {
        zone = 'after';
      } else {
        const bar = dndBarRect(el);
        const expandedBelow = walkedUp || ev.clientY > bar.bottom;
        zone = pickZone(bar, ev.clientY, allowed, { expandedBelow });
      }
      if (!zone) {
        paintDrop(null, null);
        return;
      }
      // DOM-only indicator paint — no $state, no Svelte re-render.
      paintDrop(el, {
        targetType: t.type,
        targetId: t.id,
        targetIndex: t.index,
        zone,
        connId: t.connId,
        groupId: t.groupId,
        projectId: t.projectId,
        terminalId: t.terminalId,
      });
    };

    const finish = () => {
      if (activated) commitDrop(drag, liveDrop, liveCopy);
      stopPointerDrag?.();
      stopPointerDrag = null;
      sourceEl?.classList.remove('dnd-dragging');
      dragSourceEl = null;
      clearDropPaint();
      setTreeDragActive(false);
      positionCopyBadge(0, 0, false);
    };

    stopPointerDrag?.();
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerup', finish, { once: true });
    document.addEventListener('pointercancel', finish, { once: true });
    stopPointerDrag = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
    };
  }

  // --- Import/Export ---
  let fileInput: HTMLInputElement;

  function handleExport() {
    const json = exportState();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `terminal-dashboard-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      const success = importState(reader.result as string);
      if (success) {
        await showAlert('Settings imported successfully!');
        window.location.reload(); // Reload to ensure all state is cleanly reset
      } else {
        await showAlert('Failed to import settings. Please check the file format.');
      }
    };
    reader.readAsText(file);
    input.value = ''; // Reset input
  }

  // Sidebar state
  let sidebarOpen = $state(true);
  let sidebarWidth = $state(288); // 18rem = 288px default
  let isResizingSidebar = $state(false);
  let sidebarEl: HTMLElement | null = null;
  let workspaceEl: HTMLElement | null = null;

  function startSidebarResize(e: MouseEvent) {
    e.preventDefault();
    // One $state flip for select-none; width itself is pure DOM + rAF so the
    // handle tracks the pointer without waiting on Svelte/xterm.
    isResizingSidebar = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let latest = startWidth;
    let raf = 0;
    const el = sidebarEl;
    const ws = workspaceEl;
    if (el) {
      el.style.transition = 'none';
      el.style.width = startWidth + 'px';
    }
    if (ws) {
      const frozen = ws.getBoundingClientRect().width;
      ws.style.flex = 'none';
      ws.style.width = frozen + 'px';
      ws.classList.add('pointer-events-none');
    }
    document.body.classList.add('select-none');

    function onMouseMove(ev: MouseEvent) {
      latest = Math.max(200, Math.min(600, startWidth + (ev.clientX - startX)));
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (el) el.style.width = latest + 'px';
      });
    }

    function onMouseUp() {
      if (raf) cancelAnimationFrame(raf);
      if (el) {
        el.style.width = latest + 'px';
        el.style.transition = '';
      }
      sidebarWidth = latest;
      isResizingSidebar = false;
      if (ws) {
        ws.style.flex = '';
        ws.style.width = '';
        if (!treeDragActive) ws.classList.remove('pointer-events-none');
      }
      document.body.classList.remove('select-none');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseup', onMouseUp, { once: true });
  }

  // Grid view state (live workspace for the *current* sidebar tab)
  let gridViewConnId = $state<string>('');
  let gridViewProjectId = $state<string>('');

  // Global grid layout config
  let currentGridConfig = $derived(getGridSettings());

  // Once mounted, terminals stay mounted across tab switches (only hidden via CSS).
  let mountedTerminalIds = $state<Set<string>>(new Set());

  /** Per-tab workspace snapshot so Connections / Groups / Pinned each restore
   *  their own selection + grid mode when you come back. */
  type TabWorkspace = {
    activeTerminalId: string;
    gridViewConnId: string;
    gridViewProjectId: string;
  };
  let tabWorkspace: Record<SidebarTab, TabWorkspace> = {
    connections: { activeTerminalId: '', gridViewConnId: '', gridViewProjectId: '' },
    groups: { activeTerminalId: '', gridViewConnId: '', gridViewProjectId: '' },
    pinned: { activeTerminalId: '', gridViewConnId: '__pinned__', gridViewProjectId: '__pinned__' },
  };
  let prevSidebarTab: SidebarTab | null = null;

  function ensureMounted(ids: Iterable<string>) {
    let changed = false;
    for (const id of ids) {
      if (!mountedTerminalIds.has(id)) {
        mountedTerminalIds.add(id);
        changed = true;
      }
    }
    if (changed) mountedTerminalIds = new Set(mountedTerminalIds);
  }

  function applyTabWorkspace(tab: SidebarTab, ws: TabWorkspace) {
    gridViewConnId = ws.gridViewConnId;
    gridViewProjectId = ws.gridViewProjectId;
    setActiveTerminalId(ws.activeTerminalId);

    if (tab === 'pinned') {
      // Pinned tab defaults to the pinned multi-terminal grid.
      if (!gridViewProjectId) {
        gridViewConnId = '__pinned__';
        gridViewProjectId = '__pinned__';
      }
      ensureMounted(pinnedTerminals.map((t) => t.id));
      return;
    }

    // Restore any terminals that belong to the saved single/grid view.
    if (ws.activeTerminalId) ensureMounted([ws.activeTerminalId]);
    if (ws.gridViewProjectId && ws.gridViewConnId === 'group') {
      const group = terminalGroups.find((g) => g.id === ws.gridViewProjectId);
      if (group) ensureMounted(group.terminalIds);
    } else if (ws.gridViewProjectId && ws.gridViewConnId && ws.gridViewConnId !== '__pinned__') {
      const found = findProjectById(ws.gridViewProjectId);
      if (found) ensureMounted(found.project.terminals.map((t) => t.id));
    }
  }

  // Flat list of all terminals with connection info
  let allTerminals = $derived.by(() => {
    const list: { id: string; connId: string; projectId: string; wsUrl: string; name: string; tmuxSession: string; workingDir: string; fontSize: number; gridHidden?: boolean; pinned?: boolean; savedCommands: SavedCommand[] }[] = [];
    for (const conn of connections) {
      for (const project of conn.projects) {
        for (const terminal of project.terminals) {
          list.push({
            id: terminal.id,
            connId: conn.id,
            projectId: project.id,
            wsUrl: conn.wsUrl,
            name: terminal.name,
            tmuxSession: terminal.tmuxSession,
            workingDir: terminal.workingDir,
            fontSize: terminal.fontSize ?? 14,
            gridHidden: terminal.gridHidden,
            pinned: terminal.pinned,
            savedCommands: terminal.savedCommands
          });
        }
      }
      if (conn.projectGroups) {
        for (const pg of conn.projectGroups) {
          for (const project of pg.projects) {
            for (const terminal of project.terminals) {
              list.push({
                id: terminal.id,
                connId: conn.id,
                projectId: project.id,
                wsUrl: conn.wsUrl,
                name: terminal.name,
                tmuxSession: terminal.tmuxSession,
                workingDir: terminal.workingDir,
                fontSize: terminal.fontSize ?? 14,
                gridHidden: terminal.gridHidden,
                pinned: terminal.pinned,
                savedCommands: terminal.savedCommands
              });
            }
          }
        }
      }
    }
    return list;
  });
  let pinnedTerminals = $derived(allTerminals.filter(t => t.pinned));

  // Save/restore workspace when the sidebar route changes. untrack so grid /
  // active-terminal writes don't re-enter the effect.
  $effect(() => {
    const tab = activeSidebarTab;
    untrack(() => {
      if (prevSidebarTab === tab) return;

      if (prevSidebarTab !== null) {
        tabWorkspace[prevSidebarTab] = {
          activeTerminalId,
          gridViewConnId,
          gridViewProjectId,
        };
      }

      applyTabWorkspace(tab, tabWorkspace[tab]);
      if (tab === 'pinned') {
        ensureMounted(pinnedTerminals.map((t) => t.id));
      }
      prevSidebarTab = tab;
    });
  });

  // Auto-mount terminal when it becomes active (never unmount on tab switch)
  $effect(() => {
    if (activeTerminalId && !mountedTerminalIds.has(activeTerminalId)) {
      mountedTerminalIds.add(activeTerminalId);
      mountedTerminalIds = new Set(mountedTerminalIds);
    }
  });

  // Keep pinned terminals mounted while the pinned grid is showing
  $effect(() => {
    if (gridViewConnId === '__pinned__') {
      ensureMounted(pinnedTerminals.map((t) => t.id));
    }
  });

  // --- Actions ---

  let dialogState = $state<{
    isOpen: boolean;
    type: 'prompt' | 'confirm' | 'alert' | 'command-prompt' | 'group-select';
    title: string;
    message: string;
    value: string;
    value2?: string;
    placeholder: string;
    placeholder2?: string;
    options?: { id: string; name: string }[];
    autoExecute?: boolean;
    sendCtrlCBefore?: boolean;
    confirmLabel?: string;
    destructive?: boolean;
    resolve: ((val: any) => void) | null;
  }>({
    isOpen: false,
    type: 'prompt',
    title: '',
    message: '',
    value: '',
    value2: '',
    placeholder: '',
    placeholder2: '',
    options: [],
    autoExecute: true,
    sendCtrlCBefore: false,
    confirmLabel: 'Confirm',
    destructive: false,
    resolve: null
  });

  async function showGroupSelect(title: string, options: { id: string; name: string }[]): Promise<string | null> {
    return new Promise((resolve) => {
      dialogState = {
        isOpen: true,
        type: 'group-select',
        title,
        message: '',
        value: options.length > 0 ? options[0].id : '',
        value2: '',
        placeholder: 'Or enter new group name...',
        options,
        resolve
      };
      setTimeout(() => {
        const input = document.getElementById('dialog-input');
        if (input) input.focus();
      }, 10);
    });
  }

  async function showPrompt(title: string, defaultValue: string = '', placeholder: string = ''): Promise<string | null> {
    return new Promise((resolve) => {
      dialogState = {
        isOpen: true,
        type: 'prompt',
        title,
        message: '',
        value: defaultValue,
        placeholder: placeholder || title,
        resolve
      };
      setTimeout(() => {
        const input = document.getElementById('dialog-input');
        if (input) input.focus();
      }, 10);
    });
  }

  async function showCommandPrompt(title: string, defaultLabel: string = '', defaultCommand: string = '', defaultAutoExecute: boolean = true, defaultSendCtrlCBefore: boolean = false): Promise<{label: string, command: string, autoExecute: boolean, sendCtrlCBefore: boolean} | null> {
    return new Promise((resolve) => {
      dialogState = {
        isOpen: true,
        type: 'command-prompt',
        title,
        message: '',
        value: defaultLabel,
        value2: defaultCommand,
        placeholder: 'Command label (e.g., "Dev Server")',
        placeholder2: 'Command (e.g., npm run dev)',
        autoExecute: defaultAutoExecute,
        sendCtrlCBefore: defaultSendCtrlCBefore,
        resolve
      };
      setTimeout(() => {
        const input = document.getElementById('dialog-input');
        if (input) input.focus();
      }, 10);
    });
  }

  type ConfirmOptions = {
    title?: string;
    confirmLabel?: string;
    destructive?: boolean;
  };

  /** Shared confirmation modal (not window.confirm). Used by all sidebar deletes. */
  async function showConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
    const destructive = options.destructive ?? false;
    return new Promise((resolve) => {
      dialogState = {
        isOpen: true,
        type: 'confirm',
        title: options.title ?? 'Confirm',
        message,
        value: '',
        placeholder: '',
        confirmLabel: options.confirmLabel ?? (destructive ? 'Delete' : 'Confirm'),
        destructive,
        resolve
      };
      setTimeout(() => {
        document.getElementById('dialog-confirm-btn')?.focus();
      }, 10);
    });
  }

  /** DRY helper for destructive sidebar removals. */
  async function confirmDelete(message: string, title: string): Promise<boolean> {
    return showConfirm(message, { title, destructive: true, confirmLabel: 'Delete' });
  }

  async function showAlert(message: string): Promise<void> {
    return new Promise((resolve) => {
      dialogState = {
        isOpen: true,
        type: 'alert',
        title: 'Notice',
        message,
        value: '',
        placeholder: '',
        resolve
      };
    });
  }

  function handleDialogSubmit() {
    if (dialogState.resolve) {
      if (dialogState.type === 'prompt') {
        dialogState.resolve(dialogState.value);
      } else if (dialogState.type === 'command-prompt') {
        dialogState.resolve({ label: dialogState.value, command: dialogState.value2, autoExecute: dialogState.autoExecute !== false, sendCtrlCBefore: !!dialogState.sendCtrlCBefore });
      } else if (dialogState.type === 'group-select') {
        dialogState.resolve(dialogState.value2 || dialogState.value); // Return custom text if provided, otherwise selected ID
      } else if (dialogState.type === 'confirm') {
        dialogState.resolve(true);
      } else {
        dialogState.resolve(undefined);
      }
    }
    dialogState.isOpen = false;
  }

  function handleDialogCancel() {
    if (dialogState.resolve) {
      if (dialogState.type === 'prompt' || dialogState.type === 'command-prompt' || dialogState.type === 'group-select') {
        dialogState.resolve(null);
      } else if (dialogState.type === 'confirm') {
        dialogState.resolve(false);
      } else {
        dialogState.resolve(undefined);
      }
    }
    dialogState.isOpen = false;
  }

  function handleDialogKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleDialogCancel();
    }
  }

  async function handleAddConnection() {
    const wsUrl = await showPrompt('WebSocket URL (e.g., ws://localhost:7681):', 'ws://localhost:7681');
    if (!wsUrl) return;
    const name = await showPrompt('Connection name:', 'Local Machine') || 'Unnamed';
    addConnection(name, wsUrl);
  }

  async function handleAddGroup() {
    const name = await showPrompt('Group name:', 'New Group');
    if (name) addTerminalGroup(name);
  }

  async function handleRemoveGroup(groupId: string, e: Event) {
    e.stopPropagation();
    if (!(await confirmDelete('Remove this group? Terminals will not be deleted.', 'Remove group'))) return;
    removeTerminalGroup(groupId);
    if (gridViewConnId === 'group' && gridViewProjectId === groupId) {
      gridViewConnId = '';
      gridViewProjectId = '';
    }
  }

  async function handleRemoveTerminalFromGroup(groupId: string, terminalId: string, e: Event) {
    e.stopPropagation();
    if (!(await confirmDelete('Remove this terminal from the group? The terminal itself will not be deleted.', 'Remove from group'))) return;
    removeTerminalFromGroup(groupId, terminalId);
  }

  async function handleAddToGroupPrompt(terminalId: string) {
    const options = terminalGroups.map(g => ({ id: g.id, name: g.name }));
    const result = await showGroupSelect('Select Group or Create New', options);
    if (!result) return;

    // Result is either an existing group ID or a new group name
    let group = terminalGroups.find(g => g.id === result || g.name.toLowerCase() === result.toLowerCase());

    if (!group) {
      addTerminalGroup(result);
      // get the newly created group
      group = getTerminalGroups().find(g => g.name === result);
    }

    if (group) {
      addTerminalToGroup(group.id, terminalId);
      await showAlert(`Added to group "${group.name}"`);
    }
  }
  async function handleAddProject(connId: string, groupId?: string) {
    const name = await showPrompt('Project name:');
    if (!name) return;
    addProject(connId, name, groupId);
  }

  async function handleAddProjectGroup(connId: string) {
    const name = await showPrompt('Project group name:');
    if (!name) return;
    addProjectGroup(connId, name);
  }

  async function handleRenameProjectGroup(connId: string, groupId: string, currentName: string, e: Event) {
    e.stopPropagation();
    const name = await showPrompt('Project group name:', currentName);
    if (name) {
      renameProjectGroup(connId, groupId, name);
    }
  }

  async function handleRemoveProjectGroup(connId: string, groupId: string, e: Event) {
    e.stopPropagation();
    if (!(await confirmDelete('Remove this project group and all its projects/terminals?', 'Remove project group'))) return;
    removeProjectGroup(connId, groupId);
  }

  async function handleAddTerminal(connId: string, projectId: string) {
    const name = await showPrompt('Terminal name:', 'Terminal') || 'Terminal';
    addTerminal(connId, projectId, name);
  }

  async function handleRemoveConnection(connId: string, e: Event) {
    e.stopPropagation();
    if (!(await confirmDelete('Remove this connection and all its projects/terminals?', 'Remove connection'))) return;
    removeConnection(connId);
  }

  async function handleRemoveProject(connId: string, projectId: string, e: Event) {
    e.stopPropagation();
    if (!(await confirmDelete('Remove this project and all its terminals?', 'Remove project'))) return;
    removeProject(connId, projectId);
  }

  async function handleRemoveTerminal(connId: string, projectId: string, terminalId: string, e: Event) {
    e.stopPropagation();
    if (!(await confirmDelete('Remove this terminal? Its connection will be closed.', 'Remove terminal'))) return;
    removeTerminal(connId, projectId, terminalId);
    mountedTerminalIds.delete(terminalId);
    mountedTerminalIds = new Set(mountedTerminalIds);
  }

  async function handleRemoveSavedCommand(connId: string, projectId: string, terminalId: string, cmdId: string, e: Event) {
    e.stopPropagation();
    if (!(await confirmDelete('Remove this command shortcut?', 'Remove command'))) return;
    removeSavedCommand(connId, projectId, terminalId, cmdId);
  }

  function handleDuplicateTerminal(connId: string, projectId: string, terminalId: string, e: Event) {
    e.stopPropagation();
    const dup = duplicateTerminal(connId, projectId, terminalId);
    if (dup) {
      mountedTerminalIds.add(dup.id);
      mountedTerminalIds = new Set(mountedTerminalIds);
    }
  }

  function handleDisconnect(terminalId: string, e: Event) {
    e.stopPropagation();
    closeConnection(terminalId);
    mountedTerminalIds.delete(terminalId);
    mountedTerminalIds = new Set(mountedTerminalIds);
    if (activeTerminalId === terminalId) setActiveTerminalId('');
  }

  function handleSelectTerminal(terminalId: string) {
    gridViewProjectId = '';
    gridViewConnId = '';
    setActiveTerminalId(terminalId);

    if (!mountedTerminalIds.has(terminalId)) {
      mountedTerminalIds.add(terminalId);
      mountedTerminalIds = new Set(mountedTerminalIds);
    }

    if (!isConnected(terminalId)) {
      const termInfo = allTerminals.find(t => t.id === terminalId);
      if (termInfo) {
        reconnectConnection(terminalId, termInfo.wsUrl, termInfo.tmuxSession, termInfo.workingDir);
      }
    }
  }

  function handleReconnect(terminalId: string, e: Event) {
    e.stopPropagation();
    if (!mountedTerminalIds.has(terminalId)) {
      mountedTerminalIds.add(terminalId);
      mountedTerminalIds = new Set(mountedTerminalIds);
    }
    setActiveTerminalId(terminalId);
    const termInfo = allTerminals.find(t => t.id === terminalId);
    if (termInfo) {
      reconnectConnection(terminalId, termInfo.wsUrl, termInfo.tmuxSession, termInfo.workingDir);
    }
  }

  async function handleAddCommand(connId: string, projectId: string, terminalId: string, e: Event) {
    e.stopPropagation();
    const result = await showCommandPrompt('Add Command');
    if (!result || !result.label || !result.command) return;
    addSavedCommand(connId, projectId, terminalId, result.label, result.command, result.autoExecute, result.sendCtrlCBefore);
  }

  async function handleEditCommand(connId: string, projectId: string, terminalId: string, cmd: SavedCommand, e: Event) {
    e.stopPropagation();
    const result = await showCommandPrompt('Edit Command', cmd.label, cmd.command, cmd.autoExecute !== false, !!cmd.sendCtrlCBefore);
    if (!result || !result.label || !result.command) return;
    updateSavedCommand(connId, projectId, terminalId, cmd.id, result.label, result.command, result.autoExecute, result.sendCtrlCBefore);
  }

  // region: command-run-resolve
  function handleRunCommand(terminalId: string, command: string, autoExecute: boolean, sendCtrlCBefore: boolean, e: Event) {
    e.stopPropagation();
    // Resolve FIRST — no sendInput (including Ctrl+C) before ok
    const result = resolveCommandForTerminal(terminalId, command);
    if (!result.ok) {
      void showAlert(result.error);
      return;
    }
    const payload = autoExecute ? result.text + '\n' : result.text;
    if (sendCtrlCBefore) {
      sendInput(terminalId, '\x03');
      setTimeout(() => {
        sendInput(terminalId, payload);
      }, 100);
    } else {
      sendInput(terminalId, payload);
    }
  }
  // endregion: command-run-resolve

  // region: variables-actions
  let variablesEditorRef = $state<VariableOwnerRef | null>(null);
  let variablesEditorTitle = $state('Variables');
  let textReplaceRef = $state<VariableOwnerRef | null>(null);

  function openVariables(ref: VariableOwnerRef, title: string, e?: Event) {
    e?.stopPropagation();
    variablesEditorTitle = title;
    variablesEditorRef = ref;
  }

  function openTextReplace(ref: VariableOwnerRef, e?: Event) {
    e?.stopPropagation();
    textReplaceRef = ref;
  }

  function onConnectErrorTooltip(terminalId: string): string | undefined {
    const errs = lastOnConnectErrors[terminalId];
    if (!errs?.length) return undefined;
    return errs.map((x) => `On-connect: skipped ${x.label} — ${x.error}`).join('\n');
  }
  // endregion: variables-actions

  async function handleRenameProject(connId: string, projectId: string, currentName: string, e: Event) {
    e.stopPropagation();
    const name = await showPrompt('Project name:', currentName);
    if (name) {
      import('$lib/stores.svelte').then(mod => mod.renameProject(connId, projectId, name));
    }
  }

  async function handleRenameTerminal(connId: string, projectId: string, terminalId: string, e: Event) {
    e.stopPropagation();
    const found = findTerminalById(terminalId);
    const name = await showPrompt('Terminal name:', found?.terminal.name ?? '');
    if (name) {
      import('$lib/stores.svelte').then(mod => mod.renameTerminal(connId, projectId, terminalId, name));
    }
  }

  // Clock
  let now = $state(new Date());
  setInterval(() => { now = new Date(); }, 1000);

  function nudgeGridColumns(delta: number) {
    const next = Math.max(0, Math.min(12, (currentGridConfig.columns || 0) + delta));
    setGridLayout(next, currentGridConfig.rows);
  }

  function nudgeGridRows(delta: number) {
    const next = Math.max(0, Math.min(12, (currentGridConfig.rows || 0) + delta));
    setGridLayout(currentGridConfig.columns, next);
  }

  function toggleGridView(connId: string, projectIdOrGroupId: string, e: Event) {
    e.stopPropagation();
    if (gridViewProjectId === projectIdOrGroupId) {
      gridViewProjectId = '';
      gridViewConnId = '';
    } else {
      gridViewProjectId = projectIdOrGroupId;
      gridViewConnId = connId;
      setActiveTerminalId('');
      
      if (connId === 'group') {
        const group = terminalGroups.find(g => g.id === projectIdOrGroupId);
        if (group) {
          for (const tId of group.terminalIds) mountedTerminalIds.add(tId);
          mountedTerminalIds = new Set(mountedTerminalIds);
        }
      } else {
        const found = findProjectById(projectIdOrGroupId);
        if (found) {
          for (const t of found.project.terminals) mountedTerminalIds.add(t.id);
          mountedTerminalIds = new Set(mountedTerminalIds);
        }
      }
    }
  }
</script>

<div class="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-sky-500/30 overflow-hidden" class:select-none={isResizingSidebar}>
  <!-- Header -->
  <header class="h-14 border-b border-white/5 bg-slate-950/80 backdrop-blur-md sticky top-0 z-50 flex items-center justify-between px-6">
    <div class="flex items-center gap-3">
      <button
        onclick={() => { sidebarOpen = !sidebarOpen; }}
        class="p-1.5 -ml-2 rounded-lg text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition-all active:scale-95"
        data-tooltip={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        data-tooltip-pos="bottom-right"
      >
        {#if sidebarOpen}
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        {/if}
      </button>
      <h1 class="text-lg font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">Terminal Dashboard</h1>
    </div>

    <div class="flex items-center gap-2">
      <div class="flex items-center gap-1.5 mr-2">
        <button
          onclick={handleExport}
          data-tooltip="Export dashboard configuration & connection settings to JSON"
          data-tooltip-pos="bottom"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition-all active:scale-95 group"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover:translate-y-[-1px] transition-transform"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          EXPORT
        </button>
        <button
          onclick={() => fileInput.click()}
          data-tooltip="Import dashboard settings & connections from JSON backup file"
          data-tooltip-pos="bottom"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all active:scale-95 group"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover:translate-y-[-1px] transition-transform"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          IMPORT
        </button>
        <input type="file" bind:this={fileInput} onchange={handleImport} accept=".json" class="hidden" />
      </div>

      <div class="w-px h-4 bg-white/5 mr-1"></div>
      <div class="flex items-center gap-1.5">
        <div class="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-violet-400 hover:bg-violet-500/10 transition-all" data-tooltip="Set fixed grid columns count (0 = auto)" data-tooltip-pos="bottom">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          <span>COLS</span>
          <input
            type="number"
            min="0"
            max="12"
            value={currentGridConfig.columns || ''}
            placeholder="Auto"
            class="w-8 bg-transparent border-b border-white/10 text-[11px] font-semibold text-slate-300 text-center focus:outline-none focus:border-violet-400 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            oninput={(e) => {
              const val = parseInt((e.target as HTMLInputElement).value) || 0;
              setGridLayout(Math.max(0, Math.min(12, val)), currentGridConfig.rows);
            }}
          />
          <div class="flex flex-col -space-y-0.5 ml-0.5">
            <button
              type="button"
              class="p-0.5 text-slate-500 hover:text-violet-300 rounded leading-none"
              aria-label="Increase columns"
              onclick={(e) => { e.preventDefault(); nudgeGridColumns(1); }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button
              type="button"
              class="p-0.5 text-slate-500 hover:text-violet-300 rounded leading-none"
              aria-label="Decrease columns"
              onclick={(e) => { e.preventDefault(); nudgeGridColumns(-1); }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
        </div>
        <div class="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-violet-400 hover:bg-violet-500/10 transition-all" data-tooltip="Set fixed grid rows count (0 = auto)" data-tooltip-pos="bottom">
          <span>ROWS</span>
          <input
            type="number"
            min="0"
            max="12"
            value={currentGridConfig.rows || ''}
            placeholder="Auto"
            class="w-8 bg-transparent border-b border-white/10 text-[11px] font-semibold text-slate-300 text-center focus:outline-none focus:border-violet-400 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            oninput={(e) => {
              const val = parseInt((e.target as HTMLInputElement).value) || 0;
              setGridLayout(currentGridConfig.columns, Math.max(0, Math.min(12, val)));
            }}
          />
          <div class="flex flex-col -space-y-0.5 ml-0.5">
            <button
              type="button"
              class="p-0.5 text-slate-500 hover:text-violet-300 rounded leading-none"
              aria-label="Increase rows"
              onclick={(e) => { e.preventDefault(); nudgeGridRows(1); }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
            <button
              type="button"
              class="p-0.5 text-slate-500 hover:text-violet-300 rounded leading-none"
              aria-label="Decrease rows"
              onclick={(e) => { e.preventDefault(); nudgeGridRows(-1); }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
        </div>
      </div>

      <div class="w-px h-4 bg-white/5 mr-2"></div>

      <div class="text-sm font-medium text-slate-400 font-mono bg-white/5 px-3 py-1.5 rounded-lg border border-white/5">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  </header>

  <main class="flex-1 min-h-0 flex overflow-hidden">
    <!-- Sidebar -->
    <aside
      bind:this={sidebarEl}
      class="flex flex-col border-r border-white/5 bg-slate-950 shrink-0 overflow-hidden {isResizingSidebar ? '' : 'transition-[width,opacity] duration-200'}"
      style={isResizingSidebar
        ? `opacity: ${sidebarOpen ? 1 : 0}`
        : `width: ${sidebarOpen ? sidebarWidth + 'px' : '0px'}; opacity: ${sidebarOpen ? 1 : 0}`}
    >
      <div class="flex items-center border-b border-white/5 p-2 gap-1">
        <a
          href="/connections"
          class="flex-1 py-1.5 text-center text-xs font-semibold rounded-md transition-colors {activeSidebarTab === 'connections' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}"
          data-tooltip="View server connections and project workspaces"
          data-tooltip-pos="bottom"
          aria-current={activeSidebarTab === 'connections' ? 'page' : undefined}
        >
          Connections
        </a>
        <a
          href="/groups"
          class="flex-1 py-1.5 text-center text-xs font-semibold rounded-md transition-colors {activeSidebarTab === 'groups' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}"
          data-tooltip="View custom multi-terminal layout groups"
          data-tooltip-pos="bottom"
          aria-current={activeSidebarTab === 'groups' ? 'page' : undefined}
        >
          Groups
        </a>
        <a
          href="/pinned"
          class="flex-1 py-1.5 text-center text-xs font-semibold rounded-md transition-colors {activeSidebarTab === 'pinned' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}"
          data-tooltip="View pinned active terminals"
          data-tooltip-pos="bottom"
          aria-current={activeSidebarTab === 'pinned' ? 'page' : undefined}
        >
          Pinned
        </a>
      </div>

      <!-- View settings (below tabs, above section labels) -->
      <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5 bg-slate-950/80">
        <span class="text-[9px] font-bold uppercase tracking-widest text-slate-600">View</span>
        <button
          type="button"
          role="switch"
          aria-checked={showCommandActionIcons}
          aria-label="Show command action icons in tree"
          data-tooltip="Show or hide auto-run, hit Enter, and Ctrl+C icons on command shortcuts in the tree"
          data-tooltip-pos="bottom-left"
          onclick={() => setShowCommandActionIcons(!showCommandActionIcons)}
          class="flex items-center gap-2 cursor-pointer select-none group/view"
        >
          <span class="text-[10px] text-slate-500 group-hover/view:text-slate-300 transition-colors">Command action icons</span>
          <span
            class="relative w-8 h-4 rounded-full transition-colors {showCommandActionIcons ? 'bg-sky-500' : 'bg-slate-700'}"
            aria-hidden="true"
          >
            <span
              class="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform {showCommandActionIcons ? 'translate-x-4' : 'translate-x-0'}"
            ></span>
          </span>
        </button>
      </div>

      <div class="p-3 flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
        {#if activeSidebarTab === 'connections'}
          <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 px-2">Connections</div>

          {#each connections as conn, connIdx (conn.id)}
            <div
              class="relative mb-2"
              data-dnd-row
              data-dnd-type="connection"
              data-dnd-id={conn.id}
              data-dnd-index={connIdx}
              onpointerdown={(e) => onPointerDown(e, { type: 'connection', id: conn.id, index: connIdx })}
            >
              <button data-dnd-bar class="tree-row relative w-full flex items-center px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:bg-white/5 group" onpointerdown={onRowPointerDown} onclick={(e) => onRowClick(e, () => toggleConnectionCollapse(conn.id))}>
                <div class="tree-row-label gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-sky-400 transition-transform {conn.collapsed ? '-rotate-90' : ''}" data-tooltip={conn.collapsed ? 'Expand connection' : 'Collapse connection'} data-tooltip-pos="bottom-right"><polyline points="6 9 12 15 18 9"/></svg>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-sky-400" data-tooltip="Server connection" data-tooltip-pos="bottom-right"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  <span
                    class="tree-row-name truncate text-slate-200 select-none cursor-pointer"
                    title="Click to expand/collapse"
                  >{conn.name}</span>
                </div>
                <div class="tree-row-actions" data-no-drag>
                  <div role="button" tabindex="0" data-tooltip="Edit connection variables" data-tooltip-pos="bottom-left" onclick={(e) => openVariables({ kind: 'connection', connectionId: conn.id }, `Variables · ${conn.name}`, e)} onkeydown={(e) => e.key === 'Enter' && openVariables({ kind: 'connection', connectionId: conn.id }, `Variables · ${conn.name}`)} class="p-0.5 text-slate-500 hover:text-cyan-400 rounded hover:bg-cyan-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>
                  </div>
                  <div role="button" tabindex="0" data-tooltip="Replace in commands" data-tooltip-pos="bottom-left" onclick={(e) => openTextReplace({ kind: 'connection', connectionId: conn.id }, e)} onkeydown={(e) => e.key === 'Enter' && openTextReplace({ kind: 'connection', connectionId: conn.id })} class="p-0.5 text-slate-500 hover:text-fuchsia-400 rounded hover:bg-fuchsia-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11h18"/><path d="m7 22-4-4 4-4"/><path d="M21 13H3"/></svg>
                  </div>
                  <div role="button" tabindex="0" data-tooltip="Add project group" data-tooltip-pos="bottom-left" onclick={(e) => { e.stopPropagation(); handleAddProjectGroup(conn.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddProjectGroup(conn.id)} class="p-0.5 text-slate-500 hover:text-violet-400 rounded hover:bg-violet-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                  </div>
                  <div role="button" tabindex="0" data-tooltip="Add new project workspace" data-tooltip-pos="bottom-left" onclick={(e) => { e.stopPropagation(); handleAddProject(conn.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddProject(conn.id)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </div>
                  <div role="button" tabindex="0" data-tooltip="Remove connection server" data-tooltip-pos="bottom-left" onclick={(e) => handleRemoveConnection(conn.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveConnection(conn.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </div>
                </div>
              </button>

              {#if !conn.collapsed}
                <div class="ml-4 mt-1 border-l border-slate-800 pl-2 min-w-0">
                  <div class="text-[9px] uppercase tracking-widest text-slate-600 px-2 mb-1">{conn.wsUrl}</div>

                  {#snippet projectSnippet(connId, project, projIdx, groupId)}
                    <div
                      class="relative mb-1"
                      data-dnd-row
                      data-dnd-type="project"
                      data-dnd-id={project.id}
                      data-dnd-index={projIdx}
                      data-dnd-conn={connId}
                      data-dnd-group={groupId}
                      onpointerdown={(e) => onPointerDown(e, { type: 'project', id: project.id, index: projIdx, connId, groupId })}
                    >
                      <button data-dnd-bar class="tree-row relative w-full flex items-center px-2 py-1 rounded-md text-xs transition-colors hover:bg-white/5 group" onpointerdown={onRowPointerDown} onclick={(e) => onRowClick(e, () => toggleProjectCollapse(connId, project.id))}>
                        <div class="tree-row-label gap-2">
                          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-amber-400 transition-transform {project.collapsed ? '-rotate-90' : ''}" data-tooltip={project.collapsed ? 'Expand project' : 'Collapse project'} data-tooltip-pos="bottom-right"><polyline points="6 9 12 15 18 9"/></svg>
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-amber-400" data-tooltip="Project workspace" data-tooltip-pos="bottom-right"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                          <span
                            class="tree-row-name truncate text-slate-300 select-none cursor-pointer"
                            title="Click to expand/collapse"
                          >{project.name}</span>
                        </div>
                        <div class="tree-row-actions" data-no-drag>
                          <div role="button" tabindex="0" data-tooltip="Edit project variables" data-tooltip-pos="bottom-left" onclick={(e) => openVariables({ kind: 'project', projectId: project.id }, `Variables · ${project.name}`, e)} onkeydown={(e) => e.key === 'Enter' && openVariables({ kind: 'project', projectId: project.id }, `Variables · ${project.name}`)} class="p-0.5 text-slate-500 hover:text-cyan-400 rounded hover:bg-cyan-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>
                          </div>
                          <div role="button" tabindex="0" data-tooltip="Replace in commands" data-tooltip-pos="bottom-left" onclick={(e) => openTextReplace({ kind: 'project', projectId: project.id }, e)} onkeydown={(e) => e.key === 'Enter' && openTextReplace({ kind: 'project', projectId: project.id })} class="p-0.5 text-slate-500 hover:text-fuchsia-400 rounded hover:bg-fuchsia-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11h18"/><path d="m7 22-4-4 4-4"/><path d="M21 13H3"/></svg>
                          </div>
                          <div role="button" tabindex="0" data-tooltip="Rename project" data-tooltip-pos="bottom-left" onclick={(e) => handleRenameProject(connId, project.id, project.name, e)} onkeydown={(e) => e.key === 'Enter' && handleRenameProject(connId, project.id, project.name, e)} class="p-0.5 text-slate-500 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                          </div>
                          <div role="button" tabindex="0" data-tooltip={gridViewProjectId === project.id ? 'Switch to single terminal view' : 'Switch to multi-terminal grid view'} data-tooltip-pos="bottom-left" onclick={(e) => toggleGridView(connId, project.id, e)} onkeydown={(e) => e.key === 'Enter' && toggleGridView(connId, project.id, e)} class="p-0.5 rounded transition-colors {gridViewProjectId === project.id ? 'text-violet-400 bg-violet-500/20' : 'text-slate-500 hover:text-violet-400 hover:bg-violet-500/20'}">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                          </div>
                          <div role="button" tabindex="0" data-tooltip="Add new terminal session" data-tooltip-pos="bottom-left" onclick={(e) => { e.stopPropagation(); handleAddTerminal(connId, project.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddTerminal(connId, project.id)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                          </div>
                          <div role="button" tabindex="0" data-tooltip="Remove project" data-tooltip-pos="bottom-left" onclick={(e) => handleRemoveProject(connId, project.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveProject(connId, project.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </div>
                        </div>
                      </button>

                      {#if !project.collapsed}
                        <div class="ml-4 border-l border-slate-800/50 pl-2 min-w-0">
                          {#each project.terminals as terminal, termIdx (terminal.id)}
                            {@const isMounted = mountedTerminalIds.has(terminal.id)}
                            {@const isConn = !!connectionStatuses[terminal.id]}
                            <!-- Terminal row -->
                            <div
                              class="relative mb-0.5"
                              data-dnd-row
                              data-dnd-type="terminal"
                              data-dnd-id={terminal.id}
                              data-dnd-index={termIdx}
                              data-dnd-conn={connId}
                              data-dnd-project={project.id}
                              onpointerdown={(e) => onPointerDown(e, { type: 'terminal', id: terminal.id, index: termIdx, connId, projectId: project.id })}
                            >
                              <button
                                data-dnd-bar
                                class="tree-row relative w-full flex items-center px-2 py-1 rounded-md text-xs transition-all group {activeTerminalId === terminal.id ? 'bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/30' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}"
                                onpointerdown={onRowPointerDown}
                                onclick={(e) => onRowClick(e, () => handleSelectTerminal(terminal.id))}
                              >
                                <div class="tree-row-label gap-1.5">
                                  <!-- Expand arrow for saved commands -->
                                  <div
                                    role="button" tabindex="0" data-no-drag data-tooltip="Saved command shortcuts" data-tooltip-pos="bottom-left"
                                    onclick={(e) => { e.stopPropagation(); toggleTerminalCollapse(connId, project.id, terminal.id); }}
                                    onkeydown={(e) => e.key === 'Enter' && toggleTerminalCollapse(connId, project.id, terminal.id)}
                                    class="shrink-0 p-0.5 -ml-0.5 hover:bg-white/10 rounded transition-colors"
                                  >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="transition-transform {terminal.collapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"/></svg>
                                  </div>
                                  <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${!isMounted ? 'bg-slate-600' : (isConn ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]')}`} data-tooltip={!isMounted ? 'Not initialized' : (isConn ? 'Connected' : 'Disconnected')} data-tooltip-pos="bottom-right"></div>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" data-tooltip="Terminal session" data-tooltip-pos="bottom-right"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                                  <span
                                    class="tree-row-name truncate select-none cursor-pointer text-left"
                                    title="Click the arrow to expand/collapse commands"
                                    data-tooltip={onConnectErrorTooltip(terminal.id)}
                                    data-tooltip-pos="bottom-right"
                                  >{terminal.name}</span>
                                </div>
                                <div class="tree-row-actions tree-row-actions-tight" data-no-drag>
                                  <div role="button" tabindex="0" data-tooltip={terminal.gridHidden ? 'Show in grid view' : 'Hide from grid view'} data-tooltip-pos="bottom-left" onclick={(e) => { e.stopPropagation(); toggleTerminalGridHidden(connId, project.id, terminal.id); }} onkeydown={(e) => e.key === 'Enter' && toggleTerminalGridHidden(connId, project.id, terminal.id)} class="p-0.5 rounded transition-colors {terminal.gridHidden ? 'text-slate-600 hover:text-slate-400' : 'text-sky-400 bg-sky-500/10 hover:bg-sky-500/20'}">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                      {#if terminal.gridHidden}
                                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>
                                      {:else}
                                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
                                      {/if}
                                    </svg>
                                  </div>
                                  {#if mountedTerminalIds.has(terminal.id)}
                                    <div role="button" tabindex="0" data-tooltip="Disconnect terminal session" data-tooltip-pos="bottom-left" onclick={(e) => handleDisconnect(terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleDisconnect(terminal.id, e)} class="p-0.5 text-slate-500 hover:text-amber-400 rounded hover:bg-amber-500/20 transition-colors">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64A9 9 0 0 1 20.77 15"/><path d="M6.16 6.16a9 9 0 1 0 12.68 12.68"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                                    </div>
                                  {:else}
                                    <div role="button" tabindex="0" data-tooltip="Reconnect terminal session" data-tooltip-pos="bottom-left" onclick={(e) => handleReconnect(terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleReconnect(terminal.id, e)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
                                    </div>
                                  {/if}
                                  <div role="button" tabindex="0" data-tooltip="Edit terminal variables" data-tooltip-pos="bottom-left" onclick={(e) => openVariables({ kind: 'terminal', terminalId: terminal.id }, `Variables · ${terminal.name}`, e)} onkeydown={(e) => e.key === 'Enter' && openVariables({ kind: 'terminal', terminalId: terminal.id }, `Variables · ${terminal.name}`)} class="p-0.5 text-slate-500 hover:text-cyan-400 rounded hover:bg-cyan-500/20 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>
                                  </div>
                                  <div role="button" tabindex="0" data-tooltip="Replace in commands" data-tooltip-pos="bottom-left" onclick={(e) => openTextReplace({ kind: 'terminal', terminalId: terminal.id }, e)} onkeydown={(e) => e.key === 'Enter' && openTextReplace({ kind: 'terminal', terminalId: terminal.id })} class="p-0.5 text-slate-500 hover:text-fuchsia-400 rounded hover:bg-fuchsia-500/20 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11h18"/><path d="m7 22-4-4 4-4"/><path d="M21 13H3"/></svg>
                                  </div>
                                  <div role="button" tabindex="0" data-tooltip="Duplicate terminal" data-tooltip-pos="bottom-left" onclick={(e) => handleDuplicateTerminal(connId, project.id, terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleDuplicateTerminal(connId, project.id, terminal.id, e)} class="p-0.5 text-slate-500 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                  </div>
                                  <div role="button" tabindex="0" data-tooltip="Rename terminal" data-tooltip-pos="bottom-left" onclick={(e) => handleRenameTerminal(connId, project.id, terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRenameTerminal(connId, project.id, terminal.id, e)} class="p-0.5 text-slate-500 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                  </div>
                                  <div role="button" tabindex="0" data-tooltip="Remove terminal" data-tooltip-pos="bottom-left" onclick={(e) => handleRemoveTerminal(connId, project.id, terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveTerminal(connId, project.id, terminal.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                  </div>
                                </div>
                              </button>

                              <!-- Expanded: saved commands panel -->
                              {#if !terminal.collapsed}
                                <div class="ml-5 mt-1 mb-2 pl-2 border-l border-slate-700/50 min-w-0">
                                  <!-- Saved commands -->
                                  <div class="mt-1">
                                    <div class="flex items-center justify-between px-2">
                                      <span class="text-[9px] uppercase tracking-widest text-slate-600">Commands</span>
                                      <div
                                        role="button" tabindex="0" data-no-drag data-tooltip="Add saved command shortcut" data-tooltip-pos="bottom-left"
                                        onclick={(e) => handleAddCommand(connId, project.id, terminal.id, e)}
                                        onkeydown={(e) => e.key === 'Enter' && handleAddCommand(connId, project.id, terminal.id, e)}
                                        class="p-0.5 text-slate-600 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors"
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                      </div>
                                    </div>

                                    {#if terminal.savedCommands.length === 0}
                                      <p class="text-[10px] text-slate-600 italic px-2 py-1">No saved commands</p>
                                    {:else}
                                      {#each terminal.savedCommands as cmd, cmdIdx (`${terminal.id}:${cmd.id}`)}
                                        <div
                                          class="tree-row relative flex items-center gap-1 px-1 py-0.5 rounded hover:bg-white/5 group/cmd text-[10px]"
                                          data-dnd-row
                                          data-dnd-type="command"
                                          data-dnd-id={cmd.id}
                                          data-dnd-index={cmdIdx}
                                          data-dnd-conn={connId}
                                          data-dnd-project={project.id}
                                          data-dnd-terminal={terminal.id}
                                          onpointerdown={(e) => onPointerDown(e, { type: 'command', id: cmd.id, index: cmdIdx, connId, projectId: project.id, terminalId: terminal.id })}
                                        >
                                          {#if showCommandActionIcons}
                                            <!-- On-connect toggle -->
                                            <button
                                              data-no-drag
                                              data-tooltip={cmd.isOnConnect ? 'Auto-run on connect (click to disable)' : 'Auto-run on connect (click to enable)'}
                                              data-tooltip-pos="top-left"
                                              onclick={(e) => { e.stopPropagation(); toggleCommandOnConnect(connId, project.id, terminal.id, cmd.id); }}
                                              class="shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors {cmd.isOnConnect ? 'text-emerald-400 bg-emerald-500/20' : 'text-slate-600 hover:text-slate-400'}"
                                            >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                            </button>
                                            <!-- Auto-execute toggle -->
                                            <button
                                              data-no-drag
                                              data-tooltip={cmd.autoExecute !== false ? 'Executes command with Enter (click to inject text only)' : 'Injects text only (click to auto-execute)'}
                                              data-tooltip-pos="top-left"
                                              onclick={(e) => { e.stopPropagation(); toggleCommandAutoExecute(connId, project.id, terminal.id, cmd.id); }}
                                              class="shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors {cmd.autoExecute !== false ? 'text-sky-400 bg-sky-500/20' : 'text-amber-400 bg-amber-500/20'}"
                                            >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill={cmd.autoExecute !== false ? 'none' : 'currentColor'} stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">{#if cmd.autoExecute !== false}<polygon points="5 3 19 12 5 21 5 3"/>{:else}<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6"/><path d="M9 15h4"/>{/if}</svg>
                                            </button>
                                            <!-- Ctrl+C before toggle -->
                                            <button
                                              data-no-drag
                                              data-tooltip={cmd.sendCtrlCBefore ? 'Sends Ctrl+C before running (click to disable)' : 'Send Ctrl+C before running'}
                                              data-tooltip-pos="top-left"
                                              onclick={(e) => { e.stopPropagation(); toggleCommandCtrlCBefore(connId, project.id, terminal.id, cmd.id); }}
                                              class="shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors {cmd.sendCtrlCBefore ? 'text-rose-400 bg-rose-500/20' : 'text-slate-600 hover:text-slate-400'}"
                                            >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                            </button>
                                          {/if}
                                          <!-- Label / run surface: also the drag handle for this row.
                                               Must NOT be data-no-drag — that blocked all command reordering
                                               because this flex-1 button covers nearly the whole row.
                                               Click still runs the command; a completed drag suppresses it. -->
                                          <button
                                            type="button"
                                            data-tooltip="{cmd.sendCtrlCBefore ? '(Ctrl+C) ' : ''}{cmd.autoExecute !== false ? 'Execute: ' : 'Inject: '}{cmd.command}"
                                            data-tooltip-pos="top-left"
                                            onclick={(e) => {
                                              if (pointerDragCommitted) {
                                                pointerDragCommitted = false;
                                                e.preventDefault();
                                                e.stopPropagation();
                                                return;
                                              }
                                              handleRunCommand(terminal.id, cmd.command, cmd.autoExecute !== false, !!cmd.sendCtrlCBefore, e);
                                            }}
                                            class="min-w-0 flex-1 text-left truncate text-slate-400 hover:text-white transition-colors px-1 cursor-grab active:cursor-grabbing"
                                          >
                                            <span class="font-medium text-slate-300">{cmd.label}</span>
                                            <span class="text-slate-600 ml-1">→ {cmd.command}</span>
                                          </button>
                                          <div class="tree-row-actions tree-row-actions-tight" data-no-drag>
                                            <!-- Duplicate -->
                                            <div
                                              role="button" tabindex="0" data-tooltip="Duplicate command shortcut" data-tooltip-pos="top-left"
                                              onclick={(e) => { e.stopPropagation(); duplicateSavedCommand(connId, project.id, terminal.id, cmd.id); }}
                                              onkeydown={(e) => e.key === 'Enter' && duplicateSavedCommand(connId, project.id, terminal.id, cmd.id)}
                                              class="shrink-0 p-0.5 text-slate-600 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors"
                                            >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                            </div>
                                            <!-- Edit -->
                                            <div
                                              role="button" tabindex="0" data-tooltip="Edit command shortcut" data-tooltip-pos="top-left"
                                              onclick={(e) => handleEditCommand(connId, project.id, terminal.id, cmd, e)}
                                              onkeydown={(e) => e.key === 'Enter' && handleEditCommand(connId, project.id, terminal.id, cmd, e)}
                                              class="shrink-0 p-0.5 text-slate-600 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors"
                                            >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                            </div>
                                            <!-- Remove -->
                                            <div
                                              role="button" tabindex="0" data-tooltip="Remove command shortcut" data-tooltip-pos="top-left"
                                              onclick={(e) => handleRemoveSavedCommand(connId, project.id, terminal.id, cmd.id, e)}
                                              onkeydown={(e) => e.key === 'Enter' && handleRemoveSavedCommand(connId, project.id, terminal.id, cmd.id, e)}
                                              class="shrink-0 p-0.5 text-slate-600 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors"
                                            >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                            </div>
                                          </div>
                                        </div>
                                      {/each}
                                    {/if}
                                  </div>
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/snippet}

                  <!-- Project Groups -->
                  {#if conn.projectGroups}
                    {#each conn.projectGroups as group, groupIdx (group.id)}
                      <div
                        class="relative mb-1"
                        data-dnd-row
                        data-dnd-type="project-group"
                        data-dnd-id={group.id}
                        data-dnd-index={groupIdx}
                        data-dnd-conn={conn.id}
                        data-dnd-group={group.id}
                        onpointerdown={(e) => onPointerDown(e, { type: 'project-group', id: group.id, index: groupIdx, connId: conn.id, groupId: group.id })}
                      >
                        <button data-dnd-bar class="tree-row relative w-full flex items-center px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-white/5 group/pg" onpointerdown={onRowPointerDown} onclick={(e) => onRowClick(e, () => toggleProjectGroupCollapse(conn.id, group.id))}>
                          <div class="tree-row-label gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-violet-400 transition-transform {group.collapsed ? '-rotate-90' : ''}" data-tooltip={group.collapsed ? 'Expand project group' : 'Collapse project group'} data-tooltip-pos="bottom-right"><polyline points="6 9 12 15 18 9"/></svg>
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-violet-400" data-tooltip="Project group" data-tooltip-pos="bottom-right"><path d="M15.5 17.5H22a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L11.6 3.4a2 2 0 0 0-1.67-.9H4a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h1.5"/><path d="M5 17.5v3A2 2 0 0 0 7 22.5h15a2 2 0 0 0 2-2v-3"/></svg>
                            <span
                              class="tree-row-name truncate font-medium text-slate-200 select-none cursor-pointer"
                              title="Click to expand/collapse"
                            >{group.name}</span>
                          </div>
                          <div class="tree-row-actions" data-no-drag>
                            <div role="button" tabindex="0" data-tooltip="Edit project group variables" data-tooltip-pos="bottom-left" onclick={(e) => openVariables({ kind: 'projectGroup', connectionId: conn.id, projectGroupId: group.id }, `Variables · ${group.name}`, e)} onkeydown={(e) => e.key === 'Enter' && openVariables({ kind: 'projectGroup', connectionId: conn.id, projectGroupId: group.id }, `Variables · ${group.name}`)} class="p-0.5 text-slate-500 hover:text-cyan-400 rounded hover:bg-cyan-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>
                            </div>
                            <div role="button" tabindex="0" data-tooltip="Replace in commands" data-tooltip-pos="bottom-left" onclick={(e) => openTextReplace({ kind: 'projectGroup', connectionId: conn.id, projectGroupId: group.id }, e)} onkeydown={(e) => e.key === 'Enter' && openTextReplace({ kind: 'projectGroup', connectionId: conn.id, projectGroupId: group.id })} class="p-0.5 text-slate-500 hover:text-fuchsia-400 rounded hover:bg-fuchsia-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11h18"/><path d="m7 22-4-4 4-4"/><path d="M21 13H3"/></svg>
                            </div>
                            <div role="button" tabindex="0" data-tooltip="Rename group" data-tooltip-pos="bottom-left" onclick={(e) => handleRenameProjectGroup(conn.id, group.id, group.name, e)} onkeydown={(e) => e.key === 'Enter' && handleRenameProjectGroup(conn.id, group.id, group.name, e)} class="p-0.5 text-slate-500 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                            </div>
                            <div role="button" tabindex="0" data-tooltip="Add project to group" data-tooltip-pos="bottom-left" onclick={(e) => { e.stopPropagation(); handleAddProject(conn.id, group.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddProject(conn.id, group.id)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            </div>
                            <div role="button" tabindex="0" data-tooltip="Remove group" data-tooltip-pos="bottom-left" onclick={(e) => handleRemoveProjectGroup(conn.id, group.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveProjectGroup(conn.id, group.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </div>
                          </div>
                        </button>

                        {#if !group.collapsed}
                          <div class="ml-4 border-l border-violet-800/20 pl-2 min-w-0">
                            {#if group.projects.length === 0}
                              <div class="text-[10px] text-slate-600 italic px-2 py-1">No projects in this group</div>
                            {:else}
                              {#each group.projects as project, projIdx (project.id)}
                                {@render projectSnippet(conn.id, project, projIdx, group.id)}
                              {/each}
                            {/if}
                          </div>
                        {/if}
                      </div>
                    {/each}
                  {/if}

                  <!-- Ungrouped projects -->
                  {#each conn.projects as project, projIdx (project.id)}
                    {@render projectSnippet(conn.id, project, projIdx, undefined)}
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {:else if activeSidebarTab === 'groups'}
          <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 px-2">Groups</div>
          {#each terminalGroups as group, groupIdx (group.id)}
            <div
              class="relative mb-2"
              data-dnd-row
              data-dnd-type="group"
              data-dnd-id={group.id}
              data-dnd-index={groupIdx}
              onpointerdown={(e) => onPointerDown(e, { type: 'group', id: group.id, index: groupIdx })}
            >
              <button data-dnd-bar class="tree-row relative w-full flex items-center px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:bg-white/5 group" onpointerdown={onRowPointerDown} onclick={(e) => onRowClick(e, () => toggleGroupCollapse(group.id))}>
                <div class="tree-row-label gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-indigo-400 transition-transform {group.collapsed ? '-rotate-90' : ''}" data-tooltip={group.collapsed ? 'Expand group' : 'Collapse group'} data-tooltip-pos="bottom-right"><polyline points="6 9 12 15 18 9"/></svg>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-indigo-400" data-tooltip="Custom terminal group" data-tooltip-pos="bottom-right"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  <span
                    class="tree-row-name truncate text-slate-200 select-none cursor-pointer"
                    title="Click to expand/collapse"
                  >{group.name}</span>
                </div>
                <div class="tree-row-actions" data-no-drag>
                  <div role="button" tabindex="0" data-tooltip="Edit terminal group variables" data-tooltip-pos="bottom-left" onclick={(e) => openVariables({ kind: 'terminalGroup', terminalGroupId: group.id }, `Variables · ${group.name}`, e)} onkeydown={(e) => e.key === 'Enter' && openVariables({ kind: 'terminalGroup', terminalGroupId: group.id }, `Variables · ${group.name}`)} class="p-0.5 text-slate-500 hover:text-cyan-400 rounded hover:bg-cyan-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/></svg>
                  </div>
                  <div role="button" tabindex="0" data-tooltip="Replace in commands" data-tooltip-pos="bottom-left" onclick={(e) => openTextReplace({ kind: 'terminalGroup', terminalGroupId: group.id }, e)} onkeydown={(e) => e.key === 'Enter' && openTextReplace({ kind: 'terminalGroup', terminalGroupId: group.id })} class="p-0.5 text-slate-500 hover:text-fuchsia-400 rounded hover:bg-fuchsia-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11h18"/><path d="m7 22-4-4 4-4"/><path d="M21 13H3"/></svg>
                  </div>
                  <div role="button" tabindex="0" data-tooltip={gridViewProjectId === group.id ? 'Switch to single view' : 'Switch to grid view'} data-tooltip-pos="bottom-left" onclick={(e) => toggleGridView('group', group.id, e)} onkeydown={(e) => e.key === 'Enter' && toggleGridView('group', group.id, e)} class="p-0.5 rounded transition-colors {gridViewProjectId === group.id ? 'text-violet-400 bg-violet-500/20' : 'text-slate-500 hover:text-violet-400 hover:bg-violet-500/20'}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  </div>
                  <div role="button" tabindex="0" data-tooltip="Remove custom group" data-tooltip-pos="bottom-left" onclick={(e) => handleRemoveGroup(group.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveGroup(group.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </div>
                </div>
              </button>

              {#if !group.collapsed}
                <div class="ml-4 mt-1 border-l border-slate-800 pl-2 min-w-0">
                  {#if group.terminalIds.length === 0}
                    <p class="text-[10px] text-slate-600 italic px-2 py-1">No terminals in this group</p>
                  {:else}
                    {#each group.terminalIds as terminalId, termIdx (terminalId)}
                      {@const terminal = allTerminals.find(t => t.id === terminalId)}
                      {@const isMounted = mountedTerminalIds.has(terminalId)}
                      {@const isConn = !!connectionStatuses[terminalId]}
                      {#if terminal}
                        <!-- Group Terminal row -->
                        <div
                          class="relative mb-0.5"
                          data-dnd-row
                          data-dnd-type="group-terminal"
                          data-dnd-id={terminal.id}
                          data-dnd-index={termIdx}
                          data-dnd-terminal={terminal.id}
                          data-dnd-group={group.id}
                          onpointerdown={(e) => onPointerDown(e, { type: 'group-terminal', id: terminal.id, index: termIdx, terminalId: terminal.id, groupId: group.id })}
                        >
                          <button
                            data-dnd-bar
                            class="tree-row relative w-full flex items-center px-2 py-1 rounded-md text-xs transition-all group {activeTerminalId === terminal.id ? 'bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/30' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}"
                            onclick={() => handleSelectTerminal(terminal.id)}
                          >
                            <div class="tree-row-label gap-1.5">
                              <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${!isMounted ? 'bg-slate-600' : (isConn ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]')}`} data-tooltip={!isMounted ? 'Not initialized' : (isConn ? 'Connected' : 'Disconnected')} data-tooltip-pos="bottom-right"></div>
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" data-tooltip="Terminal session" data-tooltip-pos="bottom-right"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                              <span class="tree-row-name truncate text-left">{terminal.name}</span>
                            </div>
                            <div class="tree-row-actions tree-row-actions-tight" data-no-drag>
                              <div role="button" tabindex="0" data-tooltip="Remove terminal from group" data-tooltip-pos="bottom-left" onclick={(e) => handleRemoveTerminalFromGroup(group.id, terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveTerminalFromGroup(group.id, terminal.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                              </div>
                            </div>
                          </button>
                        </div>
                      {/if}
                    {/each}
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        {:else if activeSidebarTab === 'pinned'}
          <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 px-2">Pinned Terminals</div>
          {#if pinnedTerminals.length === 0}
            <p class="text-[10px] text-slate-600 italic px-2 py-4 text-center">No pinned terminals yet. Pin terminals using the pin button in the terminal header.</p>
          {:else}
            {#each pinnedTerminals as terminal (terminal.id)}
              {@const isMounted = mountedTerminalIds.has(terminal.id)}
              {@const isConn = !!connectionStatuses[terminal.id]}
              <div class="mb-0.5">
                <button
                  class="tree-row relative w-full flex items-center px-2 py-1 rounded-md text-xs transition-all group {activeTerminalId === terminal.id ? 'bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/30' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}"
                  onclick={() => handleSelectTerminal(terminal.id)}
                >
                  <div class="tree-row-label gap-1.5">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-amber-400" data-tooltip="Pinned terminal" data-tooltip-pos="bottom-right"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
                    <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${!isMounted ? 'bg-slate-600' : (isConn ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]')}`} data-tooltip={!isMounted ? 'Not initialized' : (isConn ? 'Connected' : 'Disconnected')} data-tooltip-pos="bottom-right"></div>
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" data-tooltip="Terminal session" data-tooltip-pos="bottom-right"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                    <span class="tree-row-name truncate text-left">{terminal.name}</span>
                  </div>
                  <div class="tree-row-actions tree-row-actions-tight" data-no-drag>
                    <div role="button" tabindex="0" data-tooltip="Unpin terminal" data-tooltip-pos="bottom-left" onclick={(e) => { e.stopPropagation(); toggleTerminalPinned(terminal.connId, terminal.projectId, terminal.id); }} onkeydown={(e) => e.key === 'Enter' && toggleTerminalPinned(terminal.connId, terminal.projectId, terminal.id)} class="p-0.5 text-amber-400 hover:text-amber-300 rounded hover:bg-amber-500/20 transition-colors">
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
                    </div>
                  </div>
                </button>
              </div>
            {/each}
          {/if}
        {/if}
      </div>

      <div class="p-3 border-t border-white/5">
        {#if activeSidebarTab === 'connections'}
          <button onclick={handleAddConnection} data-tooltip="Add a new server connection" data-tooltip-pos="top" class="w-full py-2 border border-slate-700 border-dashed rounded-lg text-slate-400 hover:text-white hover:border-slate-500 hover:bg-white/5 transition-all text-xs flex items-center justify-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Connection
          </button>
        {:else if activeSidebarTab === 'groups'}
          <button onclick={handleAddGroup} data-tooltip="Add a new custom group layout" data-tooltip-pos="top" class="w-full py-2 border border-indigo-700/50 border-dashed rounded-lg text-indigo-400 hover:text-indigo-300 hover:border-indigo-500 hover:bg-indigo-500/10 transition-all text-xs flex items-center justify-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Group
          </button>
        {/if}
      </div>
    </aside>

    <!-- Resize Handle -->
    {#if sidebarOpen}
      <div
        class="sidebar-resize-handle"
        class:active={isResizingSidebar}
        onmousedown={startSidebarResize}
        role="separator"
        aria-orientation="vertical"
        tabindex="0"
      ></div>
    {/if}

    <!-- Terminal Workspace — flush edge-to-edge in single and grid views -->
    <div
      bind:this={workspaceEl}
      class="flex-1 min-w-0 relative bg-slate-950 p-0"
      class:grid-mode={!!gridViewProjectId}
      class:overflow-hidden={!gridViewProjectId || !currentGridConfig.rows}
      class:overflow-y-auto={!!gridViewProjectId && !!currentGridConfig.rows}
      class:pointer-events-none={isResizingSidebar}
      id="workspace"
      style={gridViewProjectId ? [
        currentGridConfig.columns ? `grid-template-columns: repeat(${currentGridConfig.columns}, 1fr);` : '',
        // Header is 3.5rem; no workspace padding or inter-cell gaps in dense grid.
        currentGridConfig.rows ? `--grid-row-height: calc((100vh - 3.5rem) / ${currentGridConfig.rows}); grid-template-rows: repeat(${currentGridConfig.rows}, var(--grid-row-height)); grid-auto-rows: var(--grid-row-height);` : '',
      ].filter(Boolean).join(' ') : ''}
    >
      {#each allTerminals as t (t.id)}
        {#if mountedTerminalIds.has(t.id)}
          {@const isPinnedGrid = gridViewConnId === '__pinned__'}
          {@const isGroupGrid = gridViewConnId === 'group'}
          {@const activeGroup = isGroupGrid ? terminalGroups.find(g => g.id === gridViewProjectId) : null}
          {@const isGridTarget = gridViewProjectId && (isPinnedGrid ? !!t.pinned : !t.gridHidden && (isGroupGrid ? activeGroup?.terminalIds.includes(t.id) : t.projectId === gridViewProjectId))}
          {@const isSingleTarget = !gridViewProjectId && activeTerminalId === t.id}
          {@const isVisible = isGridTarget || isSingleTarget}
          <div
            class="terminal-slot"
            class:terminal-visible={isVisible}
            class:terminal-hidden={!isVisible}
            class:terminal-grid={!!gridViewProjectId}
            class:terminal-single={!gridViewProjectId}
          >
            <div class="absolute inset-0">
              <Terminal
                terminalId={t.id}
                wsUrl={t.wsUrl}
                title={t.name}
                tmuxSession={t.tmuxSession}
                workingDir={t.workingDir}
                fontSize={t.fontSize}
                connId={t.connId}
                projectId={t.projectId}
                savedCommands={t.savedCommands}
                pinned={t.pinned}
                dense={true}
                gridCell={!!gridViewProjectId && isVisible}
                onAddToGroup={() => handleAddToGroupPrompt(t.id)}
                onTogglePin={() => toggleTerminalPinned(t.connId, t.projectId, t.id)}
                onResolveError={(msg) => { void showAlert(msg); }}
              />
            </div>
          </div>
        {/if}
      {/each}

      {#if !gridViewProjectId && (!activeTerminalId || !mountedTerminalIds.has(activeTerminalId))}
        <div class="h-full flex items-center justify-center">
          <div class="text-center">
            <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-800 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-slate-500"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            </div>
            <p class="text-slate-500 text-sm">Select a terminal from the sidebar to get started.</p>
          </div>
        </div>
      {/if}
    </div>
  </main>

  <!-- Copy-mode badge during shift-drag (shown/positioned via DOM in onPointerDown) -->
  <div
    bind:this={copyBadgeEl}
    class="fixed z-[200] pointer-events-none items-center gap-1 rounded-md bg-sky-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-lg"
    style="display: none; left: 0; top: 0;"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
    Copy
  </div>

  <!-- Dialog -->
  {#if dialogState.isOpen}
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm"
      role="presentation"
      onclick={(e) => { if (e.target === e.currentTarget) handleDialogCancel(); }}
      onkeydown={handleDialogKeydown}
    >
      <div
        class="bg-slate-900 border border-white/10 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabindex="-1"
      >
        <div class="p-4 border-b border-white/5">
          <h3 id="dialog-title" class="text-sm font-semibold text-slate-200">{dialogState.title}</h3>
        </div>
        <div class="p-4">
          {#if dialogState.type === 'prompt'}
            <input
              id="dialog-input"
              type="text"
              bind:value={dialogState.value}
              placeholder={dialogState.placeholder}
              class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all"
              onkeydown={(e) => e.key === 'Enter' && handleDialogSubmit()}
            />
          {:else if dialogState.type === 'command-prompt'}
            <div class="flex flex-col gap-3">
              <input
                id="dialog-input"
                type="text"
                bind:value={dialogState.value}
                placeholder={dialogState.placeholder}
                class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all"
                onkeydown={(e) => e.key === 'Enter' && handleDialogSubmit()}
              />
              <input
                type="text"
                bind:value={dialogState.value2}
                placeholder={dialogState.placeholder2}
                class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all font-mono"
                onkeydown={(e) => e.key === 'Enter' && handleDialogSubmit()}
              />
              <label class="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dialogState.autoExecute !== false}
                  onchange={(e) => { dialogState.autoExecute = (e.target as HTMLInputElement).checked; }}
                  class="w-4 h-4 rounded border-white/10 bg-slate-950 text-sky-500 focus:ring-sky-500/50 focus:ring-offset-0 cursor-pointer"
                />
                <span class="text-xs text-slate-400">Auto-execute <span class="text-slate-600">(send Enter after injecting)</span></span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!dialogState.sendCtrlCBefore}
                  onchange={(e) => { dialogState.sendCtrlCBefore = (e.target as HTMLInputElement).checked; }}
                  class="w-4 h-4 rounded border-white/10 bg-slate-950 text-rose-500 focus:ring-rose-500/50 focus:ring-offset-0 cursor-pointer"
                />
                <span class="text-xs text-slate-400">Send Ctrl+C first <span class="text-slate-600">(kill current process before running)</span></span>
              </label>
            </div>
          {:else if dialogState.type === 'group-select'}
            <div class="flex flex-col gap-3">
              {#if dialogState.options && dialogState.options.length > 0}
                <select
                  bind:value={dialogState.value}
                  class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all appearance-none"
                >
                  {#each dialogState.options as option}
                    <option value={option.id}>{option.name}</option>
                  {/each}
                </select>
                <div class="text-xs text-slate-500 text-center uppercase tracking-widest font-bold">Or</div>
              {/if}
              <input
                id="dialog-input"
                type="text"
                bind:value={dialogState.value2}
                placeholder={dialogState.placeholder}
                class="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/50 transition-all"
                onkeydown={(e) => e.key === 'Enter' && handleDialogSubmit()}
              />
            </div>
          {:else}
            <p class="text-sm text-slate-400">{dialogState.message}</p>
          {/if}
        </div>
        <div class="p-4 bg-slate-950/50 flex items-center justify-end gap-2">
          {#if dialogState.type !== 'alert'}
            <button
              type="button"
              onclick={handleDialogCancel}
              class="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
          {/if}
          <button
            type="button"
            id="dialog-confirm-btn"
            onclick={handleDialogSubmit}
            class="px-3 py-1.5 rounded-lg text-xs font-semibold text-white shadow-lg transition-all {dialogState.destructive
              ? 'bg-rose-500 hover:bg-rose-400 shadow-rose-500/20'
              : 'bg-sky-500 hover:bg-sky-400 shadow-sky-500/20'}"
          >
            {dialogState.type === 'prompt' || dialogState.type === 'command-prompt'
              ? 'Save'
              : dialogState.type === 'confirm'
                ? (dialogState.confirmLabel || 'Confirm')
                : 'OK'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if variablesEditorRef}
    <VariablesEditor
      scopeRef={variablesEditorRef}
      title={variablesEditorTitle}
      onClose={() => { variablesEditorRef = null; }}
    />
  {/if}
  {#if textReplaceRef}
    <TextReplaceModal
      scopeRef={textReplaceRef}
      onClose={() => { textReplaceRef = null; }}
    />
  {/if}

  <!-- Child tab routes are intentionally empty; this layout owns the UI so
       terminals stay mounted when switching Connections / Groups / Pinned. -->
  <div class="hidden" aria-hidden="true">{@render children()}</div>
</div>

<style>
  :global(body) {
    background-color: #020617;
    overflow: hidden;
  }

  :global(.terminal-hidden) {
    visibility: hidden;
    pointer-events: none;
    position: absolute;
    inset: 0;
    z-index: -10;
  }

  /* Single-terminal view fills the workspace with no margin/padding gap. */
  :global(.terminal-visible.terminal-single) {
    position: absolute;
    inset: 0;
  }

  /* Dense grid: zero gap/padding; cells share single borders (top/left on
     workspace, right/bottom on each terminal chrome). */
  :global(#workspace.grid-mode) {
    display: grid !important;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    grid-auto-rows: minmax(0, 1fr);
    gap: 0;
    padding: 0 !important;
    border-top: 1px solid rgb(51 65 85);
    border-left: 1px solid rgb(51 65 85);
  }

  :global(.terminal-visible.terminal-grid) {
    position: relative;
    min-height: 0;
    min-width: 0;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }


  /* Drop indicators painted via classList during drag (no Svelte re-render). */
  :global(.dnd-dragging) {
    opacity: 0.45;
  }
  :global([data-dnd-row].dnd-zone-before::before),
  :global([data-dnd-row].dnd-zone-after::after) {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    z-index: 10;
    pointer-events: none;
    background: rgb(56 189 248);
  }
  :global([data-dnd-row].dnd-zone-before::before) {
    top: 0;
  }
  :global([data-dnd-row].dnd-zone-after::after) {
    bottom: 0;
  }
  :global([data-dnd-row][data-dnd-type='project'].dnd-zone-before::before),
  :global([data-dnd-row][data-dnd-type='project'].dnd-zone-after::after) {
    background: rgb(245 158 11);
  }
  :global([data-dnd-row][data-dnd-type='command'].dnd-zone-before::before),
  :global([data-dnd-row][data-dnd-type='command'].dnd-zone-after::after) {
    background: rgb(16 185 129);
  }
  :global([data-dnd-row][data-dnd-type='project-group'].dnd-zone-before::before),
  :global([data-dnd-row][data-dnd-type='project-group'].dnd-zone-after::after) {
    background: rgb(139 92 246);
  }
  :global([data-dnd-row][data-dnd-type='group'].dnd-zone-before::before),
  :global([data-dnd-row][data-dnd-type='group'].dnd-zone-after::after),
  :global([data-dnd-row][data-dnd-type='group-terminal'].dnd-zone-before::before),
  :global([data-dnd-row][data-dnd-type='group-terminal'].dnd-zone-after::after) {
    background: rgb(129 140 248);
  }
  :global([data-dnd-row].dnd-zone-into) {
    background: rgb(16 185 129 / 0.1);
    border-radius: 0.375rem;
    box-shadow: inset 0 0 0 1px rgb(16 185 129 / 0.3);
  }
  :global([data-dnd-row][data-dnd-type='connection'].dnd-zone-into),
  :global([data-dnd-row][data-dnd-type='project'].dnd-zone-into) {
    background: rgb(14 165 233 / 0.1);
    box-shadow: inset 0 0 0 1px rgb(14 165 233 / 0.3);
  }
  :global([data-dnd-row][data-dnd-type='project-group'].dnd-zone-into) {
    background: rgb(139 92 246 / 0.1);
    box-shadow: inset 0 0 0 1px rgb(139 92 246 / 0.3);
  }
  :global(body.tree-dnd-active) {
    cursor: grabbing;
  }

  /* Tree rows: labels own the full row width. Actions use display:none until
     hover so they never reserve a blank strip next to the separator. */
  :global(.tree-row) {
    position: relative;
    min-width: 0;
    /* <button> defaults to text-align: center — keep tree labels left-aligned. */
    text-align: left;
  }
  :global(.tree-row-label) {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    flex: 1 1 0%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-align: left;
  }
  :global(.tree-row-name) {
    flex: 1 1 0%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  :global(.tree-row-actions) {
    position: absolute;
    right: 0.25rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    display: none;
    align-items: center;
    gap: 0.25rem;
    padding-left: 0.75rem;
    border-radius: 0.375rem;
    background: linear-gradient(to left, rgb(2 6 23) 60%, transparent);
  }
  :global(.tree-row-actions-tight) {
    gap: 0.125rem;
    padding-left: 0.5rem;
  }
  :global(.tree-row:hover > .tree-row-actions),
  :global(.tree-row:focus-within > .tree-row-actions) {
    display: flex;
  }

  /* Sidebar scrollbar */
  aside :global(::-webkit-scrollbar) {
    width: 6px;
  }
  aside :global(::-webkit-scrollbar-track) {
    background: transparent;
  }
  aside :global(::-webkit-scrollbar-thumb) {
    background: rgba(148, 163, 184, 0.15);
    border-radius: 3px;
  }
  aside :global(::-webkit-scrollbar-thumb:hover) {
    background: rgba(148, 163, 184, 0.3);
  }

  /* Resize handle */
  .sidebar-resize-handle {
    width: 4px;
    cursor: col-resize;
    background: transparent;
    position: relative;
    z-index: 20;
    flex-shrink: 0;
    transition: background-color 0.15s;
  }
  .sidebar-resize-handle::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 4px;
    height: 32px;
    border-radius: 2px;
    background: rgba(148, 163, 184, 0.15);
    transition: background-color 0.15s, height 0.15s;
  }
  .sidebar-resize-handle:hover::after,
  .sidebar-resize-handle.active::after {
    background: rgba(56, 189, 248, 0.5);
    height: 48px;
  }
  .sidebar-resize-handle:hover,
  .sidebar-resize-handle.active {
    background: rgba(56, 189, 248, 0.1);
  }
</style>

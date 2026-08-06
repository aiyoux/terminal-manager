// Hierarchical state store: Connection → Project → Terminal
// Persisted to IndexedDB

import { loadConnections, saveConnections, loadTerminalGroups, saveTerminalGroups, loadGridSettings, saveGridSettings } from './db';
import {
  type NodeVariables,
  type ResolveResult,
  sanitizeVariables,
  isValidUserKey,
  isDangerousKey,
  buildContextVars,
  buildScopeMap,
  resolveTemplate,
  countKeyReferences,
} from './variables';
import { applyLiteralReplace, countLiteralOccurrences } from './commandTextReplace';

export type { NodeVariables, ResolveResult };

export interface SavedCommand {
  id: string;
  label: string;
  command: string;
  isOnConnect: boolean;
  autoExecute?: boolean; // true = send with Enter, false = inject text only. Defaults to true.
  sendCtrlCBefore?: boolean; // true = send Ctrl+C before running. Defaults to false.
}

export interface TerminalTab {
  id: string;
  name: string;
  tmuxSession: string;
  workingDir: string;
  fontSize: number;
  savedCommands: SavedCommand[];
  collapsed: boolean;
  gridHidden?: boolean; // New prop to hide from grid views
  pinned?: boolean;
  variables?: NodeVariables;
  // Legacy compat: startupCommand is derived from savedCommands
}

export interface Project {
  id: string;
  name: string;
  terminals: TerminalTab[];
  collapsed: boolean;
  variables?: NodeVariables;
}

export interface ProjectGroup {
  id: string;
  name: string;
  projects: Project[];
  collapsed: boolean;
  variables?: NodeVariables;
}

export interface Connection {
  id: string;
  name: string;
  wsUrl: string;
  projects: Project[];
  projectGroups?: ProjectGroup[];
  collapsed: boolean;
  variables?: NodeVariables;
}

export interface TerminalGroup {
  id: string;
  name: string;
  terminalIds: string[];
  collapsed: boolean;
  variables?: NodeVariables;
}

export interface GridSettings {
  columns: number;
  rows: number;
}

function uid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID 
    ? crypto.randomUUID() 
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Reactive state
let connections = $state<Connection[]>([]);
let terminalGroups = $state<TerminalGroup[]>([]);
let gridSettings = $state<GridSettings>({ columns: 0, rows: 0 });
let activeTerminalId = $state<string>('');
let loaded = $state(false);

// Migrate old data: convert startupCommand string to savedCommands array
function migrateTerminal(t: any): TerminalTab {
  if (t.fontSize === undefined) t.fontSize = 14;
  if (!t.savedCommands) {
    t.savedCommands = [];
    if (t.startupCommand) {
      t.savedCommands.push({
        id: uid(),
        label: 'Startup',
        command: t.startupCommand,
        isOnConnect: true,
      });
    }
    delete t.startupCommand;
  }
  if (t.collapsed === undefined) t.collapsed = true;
  t.variables = sanitizeVariables(t.variables);
  return t as TerminalTab;
}

function normalizeProject(proj: Project) {
  proj.variables = sanitizeVariables(proj.variables);
  proj.terminals = (proj.terminals || []).map((t) => migrateTerminal(t));
}

/** Single walk for load + import — all five variable owner kinds. */
export function normalizeState(
  conns: Connection[],
  groups: TerminalGroup[]
): { connections: Connection[]; terminalGroups: TerminalGroup[] } {
  for (const conn of conns) {
    conn.variables = sanitizeVariables(conn.variables);
    conn.projects = conn.projects || [];
    conn.projectGroups = conn.projectGroups || [];
    for (const proj of conn.projects) normalizeProject(proj);
    for (const pg of conn.projectGroups) {
      pg.variables = sanitizeVariables(pg.variables);
      pg.projects = pg.projects || [];
      for (const proj of pg.projects) normalizeProject(proj);
    }
  }
  for (const g of groups) {
    g.variables = sanitizeVariables(g.variables);
    g.terminalIds = Array.isArray(g.terminalIds) ? g.terminalIds : [];
  }
  return { connections: conns, terminalGroups: groups };
}

/** Deep-clone saved commands with fresh IDs so duplicated terminals stay independent. */
function cloneSavedCommands(commands: SavedCommand[] | undefined | null): SavedCommand[] {
  if (!commands?.length) return [];
  return commands.map((cmd) => ({
    id: uid(),
    label: cmd.label,
    command: cmd.command,
    isOnConnect: !!cmd.isOnConnect,
    autoExecute: cmd.autoExecute,
    sendCtrlCBefore: cmd.sendCtrlCBefore,
  }));
}

/**
 * Older terminal duplicates shared command IDs across terminals, which makes
 * drag-over highlights match every copy. Re-id collisions so IDs are unique globally.
 */
function ensureUniqueCommandIds(conns: Connection[]): boolean {
  const seen = new Set<string>();
  let changed = false;
  const visit = (terminals: TerminalTab[]) => {
    for (const terminal of terminals) {
      for (const cmd of terminal.savedCommands || []) {
        if (!cmd.id || seen.has(cmd.id)) {
          cmd.id = uid();
          changed = true;
        }
        seen.add(cmd.id);
      }
    }
  };
  for (const conn of conns) {
    for (const proj of conn.projects || []) visit(proj.terminals || []);
    for (const pg of conn.projectGroups || []) {
      for (const proj of pg.projects || []) visit(proj.terminals || []);
    }
  }
  return changed;
}

// Load from IndexedDB on init
if (typeof window !== 'undefined') {
  Promise.all([
    loadConnections<Connection[]>(),
    loadTerminalGroups<TerminalGroup[]>(),
    loadGridSettings<GridSettings>()
  ]).then(([connData, groupData, gridData]) => {
    const conns = connData ?? [];
    const groups = groupData ?? [];
    if (connData || groupData) {
      normalizeState(conns, groups);
      const reIded = ensureUniqueCommandIds(conns);
      connections = conns;
      terminalGroups = groups;
      if (reIded) {
        saveConnections($state.snapshot(connections));
      }
    }
    if (gridData) {
      gridSettings = gridData;
    }
    loaded = true;
  });
}

function save() {
  saveConnections($state.snapshot(connections));
}

function saveGroups() {
  saveTerminalGroups($state.snapshot(terminalGroups));
}

// --- Persistence & Migration ---

export function exportState(): string {
  return JSON.stringify({
    connections: $state.snapshot(connections),
    terminalGroups: $state.snapshot(terminalGroups),
    gridSettings: $state.snapshot(gridSettings)
  }, null, 2);
}

export function importState(json: string): boolean {
  try {
    const data = JSON.parse(json);
    
    // Check if new format or old format
    let conns = Array.isArray(data) ? data : data.connections;
    let groups = Array.isArray(data) ? [] : (data.terminalGroups || []);

    if (!Array.isArray(conns)) return false;

    // Basic validation and migration
    for (const conn of conns) {
      if (!conn.id || !conn.name) return false;
      conn.projects = conn.projects || [];
      conn.projectGroups = conn.projectGroups || [];
      if (!Array.isArray(conn.projects) || !Array.isArray(conn.projectGroups)) return false;
      for (const proj of conn.projects) {
        if (!proj.id || !proj.name || !Array.isArray(proj.terminals)) return false;
      }
      for (const pg of conn.projectGroups) {
        if (!pg.id || !pg.name || !Array.isArray(pg.projects)) return false;
        for (const proj of pg.projects) {
          if (!proj.id || !proj.name || !Array.isArray(proj.terminals)) return false;
        }
      }
    }

    normalizeState(conns, groups);
    ensureUniqueCommandIds(conns);
    connections = conns;
    terminalGroups = groups;
    if (data.gridSettings) {
      gridSettings = data.gridSettings;
      saveGridSettings($state.snapshot(gridSettings));
    }
    save();
    saveGroups();
    return true;
  } catch (e) {
    console.error('Failed to import state:', e);
    return false;
  }
}

// --- Reordering ---

function moveItem<T>(arr: T[], fromIndex: number, toIndex: number) {
  // Allow toIndex === arr.length (append at end). The pre-splice length is
  // checked here; after removing the source the array is one shorter, so an
  // append index equal to the original length lands at the new tail.
  if (toIndex < 0 || toIndex > arr.length) return;
  const item = arr.splice(fromIndex, 1)[0];
  arr.splice(toIndex, 0, item);
}

export function reorderConnections(fromIndex: number, toIndex: number) {
  moveItem(connections, fromIndex, toIndex);
  save();
}

export function reorderProjects(connId: string, fromIndex: number, toIndex: number) {
  const conn = connections.find(c => c.id === connId);
  if (conn) {
    moveItem(conn.projects, fromIndex, toIndex);
    save();
  }
}

export function reorderTerminals(connId: string, projectId: string, fromIndex: number, toIndex: number) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  if (project) {
    moveItem(project.terminals, fromIndex, toIndex);
    save();
  }
}

export function moveTerminal(terminalId: string, targetProjectId: string, toIndex: number = 0) {
  const srcFound = findTerminalById(terminalId);
  const destFound = findProjectById(targetProjectId);
  if (!srcFound || !destFound) return;

  const { project: srcProject, terminal } = srcFound;
  const { project: destProject } = destFound;

  // Remove from source project
  const srcIdx = srcProject.terminals.findIndex(t => t.id === terminalId);
  if (srcIdx > -1) {
    srcProject.terminals.splice(srcIdx, 1);
  }

  // Insert into target project
  const idx = Math.max(0, Math.min(toIndex, destProject.terminals.length));
  destProject.terminals.splice(idx, 0, terminal);

  save();
}

export function reorderSavedCommands(connId: string, projectId: string, terminalId: string, fromIndex: number, toIndex: number) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (terminal) {
    moveItem(terminal.savedCommands, fromIndex, toIndex);
    save();
  }
}

export function moveSavedCommand(sourceTerminalId: string, destTerminalId: string, commandId: string, toIndex: number) {
  const sourceFound = findTerminalById(sourceTerminalId);
  const destFound = findTerminalById(destTerminalId);
  if (!sourceFound || !destFound) return;

  const cmdIdx = sourceFound.terminal.savedCommands.findIndex(c => c.id === commandId);
  if (cmdIdx === -1) return;

  const [cmd] = sourceFound.terminal.savedCommands.splice(cmdIdx, 1);

  if (sourceTerminalId === destTerminalId) {
    const idx = Math.max(0, Math.min(toIndex, sourceFound.terminal.savedCommands.length));
    sourceFound.terminal.savedCommands.splice(idx, 0, cmd);
  } else {
    const idx = Math.max(0, Math.min(toIndex, destFound.terminal.savedCommands.length));
    destFound.terminal.savedCommands.splice(idx, 0, cmd);
  }

  save();
}

export function duplicateSavedCommand(connId: string, projectId: string, terminalId: string, commandId: string): SavedCommand | null {
  const found = findTerminalById(terminalId);
  if (!found) return null;

  const idx = found.terminal.savedCommands.findIndex(c => c.id === commandId);
  if (idx === -1) return null;

  const source = found.terminal.savedCommands[idx];
  const newCmd: SavedCommand = {
    ...source,
    id: uid(),
    label: `${source.label} (Copy)`,
  };

  found.terminal.savedCommands.splice(idx + 1, 0, newCmd);
  save();
  return newCmd;
}

// --- Duplicate (copy) functions for shift-drag ---

/** Deep-clone a project with fresh IDs on all children. */
function cloneProject(project: Project, sameList: boolean): Project {
  return {
    id: uid(),
    name: sameList ? `${project.name} (Copy)` : project.name,
    terminals: project.terminals.map(t => cloneTerminal(t, sameList)),
    collapsed: project.collapsed ?? false,
    variables: { ...(project.variables ?? {}) },
  };
}

/** Deep-clone a terminal with fresh command IDs. */
function cloneTerminal(term: TerminalTab, sameList: boolean): TerminalTab {
  const id = uid();
  return {
    id,
    name: sameList ? `${term.name} (Copy)` : term.name,
    tmuxSession: `td-${id}`,
    workingDir: term.workingDir || '',
    fontSize: term.fontSize || 14,
    savedCommands: cloneSavedCommands(term.savedCommands),
    collapsed: term.collapsed ?? true,
    pinned: false,
    gridHidden: term.gridHidden ?? false,
    variables: { ...(term.variables ?? {}) },
  };
}

export function duplicateConnection(connId: string, toIndex: number, sameList: boolean): Connection | null {
  const source = connections.find(c => c.id === connId);
  if (!source) return null;
  const copy: Connection = {
    id: uid(),
    name: sameList ? `${source.name} (Copy)` : source.name,
    wsUrl: source.wsUrl,
    projects: source.projects.map(p => cloneProject(p, false)),
    projectGroups: (source.projectGroups ?? []).map(pg => ({
      id: uid(),
      name: pg.name,
      projects: pg.projects.map(p => cloneProject(p, false)),
      collapsed: pg.collapsed ?? false,
      variables: { ...(pg.variables ?? {}) },
    })),
    collapsed: false,
    variables: { ...(source.variables ?? {}) },
  };
  const idx = Math.max(0, Math.min(toIndex, connections.length));
  connections.splice(idx, 0, copy);
  save();
  return copy;
}

export function duplicateProject(
  projectId: string,
  targetConnId: string,
  targetGroupId: string | null,
  toIndex: number,
  sameList: boolean,
): Project | null {
  const found = findProjectById(projectId);
  if (!found) return null;
  const destConn = connections.find(c => c.id === targetConnId);
  if (!destConn) return null;

  const copy = cloneProject(found.project, sameList);

  if (targetGroupId) {
    if (!destConn.projectGroups) destConn.projectGroups = [];
    const destGroup = destConn.projectGroups.find(g => g.id === targetGroupId);
    if (destGroup) {
      const idx = Math.max(0, Math.min(toIndex, destGroup.projects.length));
      destGroup.projects.splice(idx, 0, copy);
    } else {
      destConn.projects.push(copy);
    }
  } else {
    const idx = Math.max(0, Math.min(toIndex, destConn.projects.length));
    destConn.projects.splice(idx, 0, copy);
  }
  save();
  return copy;
}

export function duplicateProjectGroup(
  connId: string,
  groupId: string,
  toIndex: number,
  sameList: boolean,
): ProjectGroup | null {
  const conn = connections.find(c => c.id === connId);
  if (!conn || !conn.projectGroups) return null;
  const source = conn.projectGroups.find(g => g.id === groupId);
  if (!source) return null;

  const copy: ProjectGroup = {
    id: uid(),
    name: sameList ? `${source.name} (Copy)` : source.name,
    projects: source.projects.map(p => cloneProject(p, false)),
    collapsed: false,
    variables: { ...(source.variables ?? {}) },
  };
  const idx = Math.max(0, Math.min(toIndex, conn.projectGroups.length));
  conn.projectGroups.splice(idx, 0, copy);
  save();
  return copy;
}

export function duplicateTerminalTo(
  terminalId: string,
  targetProjectId: string,
  toIndex: number,
  sameList: boolean,
): TerminalTab | null {
  const srcFound = findTerminalById(terminalId);
  const destFound = findProjectById(targetProjectId);
  if (!srcFound || !destFound) return null;

  const copy = cloneTerminal(srcFound.terminal, sameList);
  const idx = Math.max(0, Math.min(toIndex, destFound.project.terminals.length));
  destFound.project.terminals.splice(idx, 0, copy);
  save();
  return copy;
}

export function duplicateSavedCommandTo(
  sourceTerminalId: string,
  commandId: string,
  destTerminalId: string,
  toIndex: number,
  sameList: boolean,
): SavedCommand | null {
  const srcFound = findTerminalById(sourceTerminalId);
  const destFound = findTerminalById(destTerminalId);
  if (!srcFound || !destFound) return null;

  const source = srcFound.terminal.savedCommands.find(c => c.id === commandId);
  if (!source) return null;

  const newCmd: SavedCommand = {
    ...source,
    id: uid(),
    label: sameList ? `${source.label} (Copy)` : source.label,
  };
  const idx = Math.max(0, Math.min(toIndex, destFound.terminal.savedCommands.length));
  destFound.terminal.savedCommands.splice(idx, 0, newCmd);
  save();
  return newCmd;
}

export function duplicateGroup(groupId: string, toIndex: number, sameList: boolean): TerminalGroup | null {
  const source = terminalGroups.find(g => g.id === groupId);
  if (!source) return null;

  const copy: TerminalGroup = {
    id: uid(),
    name: sameList ? `${source.name} (Copy)` : source.name,
    terminalIds: [...source.terminalIds],
    collapsed: false,
    variables: { ...(source.variables ?? {}) },
  };
  const idx = Math.max(0, Math.min(toIndex, terminalGroups.length));
  terminalGroups.splice(idx, 0, copy);
  saveGroups();
  return copy;
}

export function copyTerminalToGroup(
  terminalId: string,
  targetGroupId: string,
  toIndex: number,
): void {
  const group = terminalGroups.find(g => g.id === targetGroupId);
  if (!group) return;
  if (group.terminalIds.includes(terminalId)) return;
  const idx = Math.max(0, Math.min(toIndex, group.terminalIds.length));
  group.terminalIds.splice(idx, 0, terminalId);
  saveGroups();
}

// --- Connection CRUD ---

export function getConnections(): Connection[] {
  return connections;
}

export function getTerminalGroups(): TerminalGroup[] {
  return terminalGroups;
}

export function isLoaded(): boolean {
  return loaded;
}

// Group Operations
export function addTerminalGroup(name: string) {
  terminalGroups.push({
    id: uid(),
    name,
    terminalIds: [],
    collapsed: false,
    variables: {},
  });
  saveGroups();
}

export function removeTerminalGroup(groupId: string) {
  terminalGroups = terminalGroups.filter(g => g.id !== groupId);
  saveGroups();
}

export function toggleGroupCollapse(groupId: string) {
  const group = terminalGroups.find(g => g.id === groupId);
  if (group) {
    group.collapsed = !group.collapsed;
    saveGroups();
  }
}

export function addTerminalToGroup(groupId: string, terminalId: string) {
  const group = terminalGroups.find(g => g.id === groupId);
  if (group && !group.terminalIds.includes(terminalId)) {
    group.terminalIds.push(terminalId);
    saveGroups();
  }
}

export function removeTerminalFromGroup(groupId: string, terminalId: string) {
  const group = terminalGroups.find(g => g.id === groupId);
  if (group) {
    group.terminalIds = group.terminalIds.filter(id => id !== terminalId);
    saveGroups();
  }
}

export function reorderGroups(fromIndex: number, toIndex: number) {
  moveItem(terminalGroups, fromIndex, toIndex);
  saveGroups();
}

export function reorderGroupTerminals(groupId: string, fromIndex: number, toIndex: number) {
  const group = terminalGroups.find(g => g.id === groupId);
  if (group) {
    moveItem(group.terminalIds, fromIndex, toIndex);
    saveGroups();
  }
}

export function getActiveTerminalId(): string {
  return activeTerminalId;
}

export function setActiveTerminalId(id: string) {
  activeTerminalId = id;
}

export function addConnection(name: string, wsUrl: string): Connection {
  const conn: Connection = {
    id: uid(),
    name,
    wsUrl,
    projects: [],
    collapsed: false,
    variables: {},
  };
  connections.push(conn);
  save();
  return conn;
}

export function removeConnection(connId: string) {
  const idx = connections.findIndex(c => c.id === connId);
  if (idx > -1) connections.splice(idx, 1);

  if (!findTerminalById(activeTerminalId)) {
    activeTerminalId = '';
  }
  save();
}

export function toggleConnectionCollapse(connId: string) {
  const conn = connections.find(c => c.id === connId);
  if (conn) conn.collapsed = !conn.collapsed;
  save();
}

// --- Project CRUD ---

export function addProject(connId: string, name: string, groupId?: string): Project | null {
  const conn = connections.find(c => c.id === connId);
  if (!conn) return null;

  const project: Project = {
    id: uid(),
    name,
    terminals: [],
    collapsed: false,
    variables: {},
  };

  if (groupId) {
    if (!conn.projectGroups) conn.projectGroups = [];
    const group = conn.projectGroups.find(g => g.id === groupId);
    if (group) {
      group.projects.push(project);
      save();
      return project;
    }
  }

  conn.projects.push(project);
  save();
  return project;
}

export function removeProject(connId: string, projectId: string) {
  const found = findProjectById(projectId);
  if (!found) return;

  const { conn, group } = found;
  if (group) {
    const idx = group.projects.findIndex(p => p.id === projectId);
    if (idx > -1) group.projects.splice(idx, 1);
  } else {
    const idx = conn.projects.findIndex(p => p.id === projectId);
    if (idx > -1) conn.projects.splice(idx, 1);
  }

  if (!findTerminalById(activeTerminalId)) {
    activeTerminalId = '';
  }
  save();
}

export function toggleProjectCollapse(connId: string, projectId: string) {
  const found = findProjectById(projectId);
  if (found) {
    found.project.collapsed = !found.project.collapsed;
    save();
  }
}

// --- Terminal CRUD ---

export function addTerminal(connId: string, projectId: string, name: string): TerminalTab | null {
  const found = findProjectById(projectId);
  if (!found) return null;

  const id = uid();
  const terminal: TerminalTab = {
    id,
    name,
    tmuxSession: `td-${id}`,
    workingDir: '',
    fontSize: 14,
    savedCommands: [],
    collapsed: true,
    variables: {},
  };
  found.project.terminals.push(terminal);
  activeTerminalId = terminal.id;
  save();
  return terminal;
}

export function duplicateTerminal(connId: string, projectId: string, terminalId: string): TerminalTab | null {
  const found = findTerminalById(terminalId);
  if (!found) return null;

  const source = found.terminal;
  const id = uid();
  // Fresh terminal id + fresh command ids so config/DND state is fully independent.
  const newTerminal: TerminalTab = {
    id,
    name: `${source.name} (Copy)`,
    tmuxSession: `td-${id}`,
    workingDir: source.workingDir || '',
    fontSize: source.fontSize || 14,
    savedCommands: cloneSavedCommands(source.savedCommands),
    collapsed: source.collapsed ?? true,
    pinned: source.pinned ?? false,
    gridHidden: source.gridHidden ?? false,
    variables: { ...(source.variables ?? {}) },
  };

  const idx = found.project.terminals.findIndex(t => t.id === terminalId);
  if (idx > -1) {
    found.project.terminals.splice(idx + 1, 0, newTerminal);
  } else {
    found.project.terminals.push(newTerminal);
  }

  activeTerminalId = newTerminal.id;
  save();
  return newTerminal;
}

export function removeTerminal(connId: string, projectId: string, terminalId: string) {
  const found = findTerminalById(terminalId);
  if (!found) return;

  const idx = found.project.terminals.findIndex(t => t.id === terminalId);
  if (idx > -1) found.project.terminals.splice(idx, 1);

  if (activeTerminalId === terminalId) {
    activeTerminalId = '';
  }
  save();
}

export function renameProject(connId: string, projectId: string, name: string) {
  const found = findProjectById(projectId);
  if (found) {
    found.project.name = name;
    save();
  }
}

export function renameTerminal(connId: string, projectId: string, terminalId: string, name: string) {
  const found = findTerminalById(terminalId);
  if (found) {
    found.terminal.name = name;
    save();
  }
}

export function toggleTerminalCollapse(connId: string, projectId: string, terminalId: string) {
  const found = findTerminalById(terminalId);
  if (found) {
    found.terminal.collapsed = !found.terminal.collapsed;
    save();
  }
}

export function toggleTerminalPinned(connId: string, projectId: string, terminalId: string) {
  const found = findTerminalById(terminalId);
  if (found) {
    found.terminal.pinned = !found.terminal.pinned;
    save();
  }
}

export function toggleTerminalGridHidden(connId: string, projectId: string, terminalId: string) {
  const found = findTerminalById(terminalId);
  if (found) {
    found.terminal.gridHidden = !found.terminal.gridHidden;
    save();
  }
}

export function getGridSettings(): GridSettings {
  return gridSettings;
}

export function setGridLayout(columns: number, rows: number) {
  gridSettings = { columns, rows };
  saveGridSettings($state.snapshot(gridSettings));
}

export function updateTerminalFontSize(connId: string, projectId: string, terminalId: string, fontSize: number) {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (terminal) {
    terminal.fontSize = fontSize;
    save();
  }
}

// --- Saved Command CRUD ---

export function addSavedCommand(connId: string, projectId: string, terminalId: string, label: string, command: string, autoExecute: boolean = true, sendCtrlCBefore: boolean = false, isOnConnect: boolean = false): SavedCommand | null {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (!terminal) return null;

  const cmd: SavedCommand = {
    id: uid(),
    label,
    command,
    isOnConnect,
    autoExecute,
    sendCtrlCBefore,
  };
  terminal.savedCommands.push(cmd);
  save();
  return cmd;
}

export function removeSavedCommand(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (!terminal) return;

  const idx = terminal.savedCommands.findIndex(c => c.id === cmdId);
  if (idx > -1) terminal.savedCommands.splice(idx, 1);
  save();
}

export function updateSavedCommand(connId: string, projectId: string, terminalId: string, cmdId: string, newLabel: string, newCommand: string, autoExecute?: boolean, sendCtrlCBefore?: boolean, isOnConnect?: boolean) {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) {
    cmd.label = newLabel;
    cmd.command = newCommand;
    if (autoExecute !== undefined) cmd.autoExecute = autoExecute;
    if (sendCtrlCBefore !== undefined) cmd.sendCtrlCBefore = sendCtrlCBefore;
    if (isOnConnect !== undefined) cmd.isOnConnect = isOnConnect;
    save();
  }
}

export function toggleCommandAutoExecute(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) {
    cmd.autoExecute = cmd.autoExecute === false ? true : false;
    save();
  }
}

export function toggleCommandCtrlCBefore(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) {
    cmd.sendCtrlCBefore = !cmd.sendCtrlCBefore;
    save();
  }
}

export function toggleCommandOnConnect(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) {
    cmd.isOnConnect = !cmd.isOnConnect;
    save();
  }
}

/** Module-level map for UI; updated on each on-connect attempt (mutate only — do not reassign). */
export const lastOnConnectErrors = $state<Record<string, { label: string; error: string }[]>>({});

export function setLastOnConnectErrors(terminalId: string, errors: { label: string; error: string }[]) {
  lastOnConnectErrors[terminalId] = errors;
}

export function getLastOnConnectErrors(terminalId: string): { label: string; error: string }[] {
  return lastOnConnectErrors[terminalId] ?? [];
}

function collectOnConnectResolution(terminalId: string): {
  commands: string[];
  errors: { label: string; error: string }[];
} {
  const found = findTerminalById(terminalId);
  if (!found) return { commands: [], errors: [] };
  const commands: string[] = [];
  const errors: { label: string; error: string }[] = [];
  for (const c of found.terminal.savedCommands.filter((x) => x.isOnConnect)) {
    const r = resolveCommandForTerminal(terminalId, c.command);
    if (r.ok) commands.push(r.text);
    else errors.push({ label: c.label, error: r.error });
  }
  return { commands, errors };
}

/** Successfully resolved on-connect command texts only (partial success). */
export function getOnConnectCommands(terminalId: string): string[] {
  return collectOnConnectResolution(terminalId).commands;
}

export function getOnConnectResolutionErrors(
  terminalId: string
): { label: string; error: string }[] {
  return collectOnConnectResolution(terminalId).errors;
}

/** Single walk for connectionManager. */
export function getOnConnectResolution(terminalId: string) {
  return collectOnConnectResolution(terminalId);
}

// Legacy compat
export function updateTerminalConfig(connId: string, projectId: string, terminalId: string, config: { name?: string; workingDir?: string; startupCommand?: string }) {
  const terminal = findTerminalById(terminalId)?.terminal;
  if (!terminal) return;
  if (config.name !== undefined) terminal.name = config.name;
  if (config.workingDir !== undefined) terminal.workingDir = config.workingDir;
  save();
}

// --- Project Group CRUD ---

export function addProjectGroup(connId: string, name: string): ProjectGroup | null {
  const conn = connections.find(c => c.id === connId);
  if (!conn) return null;

  if (!conn.projectGroups) conn.projectGroups = [];

  const group: ProjectGroup = {
    id: uid(),
    name,
    projects: [],
    collapsed: false,
    variables: {},
  };
  conn.projectGroups.push(group);
  save();
  return group;
}

export function removeProjectGroup(connId: string, groupId: string) {
  const conn = connections.find(c => c.id === connId);
  if (!conn || !conn.projectGroups) return;

  conn.projectGroups = conn.projectGroups.filter(g => g.id !== groupId);

  if (!findTerminalById(activeTerminalId)) {
    activeTerminalId = '';
  }
  save();
}

export function renameProjectGroup(connId: string, groupId: string, name: string) {
  const conn = connections.find(c => c.id === connId);
  const group = conn?.projectGroups?.find(g => g.id === groupId);
  if (group) {
    group.name = name;
    save();
  }
}

export function toggleProjectGroupCollapse(connId: string, groupId: string) {
  const conn = connections.find(c => c.id === connId);
  const group = conn?.projectGroups?.find(g => g.id === groupId);
  if (group) {
    group.collapsed = !group.collapsed;
    save();
  }
}

export function reorderProjectGroups(connId: string, fromIndex: number, toIndex: number) {
  const conn = connections.find(c => c.id === connId);
  if (conn && conn.projectGroups) {
    moveItem(conn.projectGroups, fromIndex, toIndex);
    save();
  }
}

export function moveProject(
  projectId: string,
  targetConnId: string,
  targetGroupId: string | null, // null means ungrouped
  toIndex: number
) {
  const found = findProjectById(projectId);
  if (!found) return;

  const { conn: srcConn, group: srcGroup, project } = found;

  // Remove from source list
  if (srcGroup) {
    const idx = srcGroup.projects.findIndex(p => p.id === projectId);
    if (idx > -1) srcGroup.projects.splice(idx, 1);
  } else {
    const idx = srcConn.projects.findIndex(p => p.id === projectId);
    if (idx > -1) srcConn.projects.splice(idx, 1);
  }

  // Insert into target list
  const destConn = connections.find(c => c.id === targetConnId);
  if (!destConn) {
    // Revert/restore to source if destination not found
    if (srcGroup) {
      srcGroup.projects.push(project);
    } else {
      srcConn.projects.push(project);
    }
    return;
  }

  if (targetGroupId) {
    if (!destConn.projectGroups) destConn.projectGroups = [];
    const destGroup = destConn.projectGroups.find(g => g.id === targetGroupId);
    if (destGroup) {
      const idx = Math.max(0, Math.min(toIndex, destGroup.projects.length));
      destGroup.projects.splice(idx, 0, project);
    } else {
      destConn.projects.push(project);
    }
  } else {
    const idx = Math.max(0, Math.min(toIndex, destConn.projects.length));
    destConn.projects.splice(idx, 0, project);
  }

  save();
}

export function findProjectById(projectId: string): { conn: Connection; group: ProjectGroup | null; project: Project } | null {
  for (const conn of connections) {
    const project = conn.projects.find(p => p.id === projectId);
    if (project) return { conn, group: null, project };
    if (conn.projectGroups) {
      for (const group of conn.projectGroups) {
        const p = group.projects.find(proj => proj.id === projectId);
        if (p) return { conn, group, project: p };
      }
    }
  }
  return null;
}

export interface TerminalAncestry {
  conn: Connection;
  projectGroup: ProjectGroup | null;
  project: Project;
  terminal: TerminalTab;
  /** Groups that list this terminal, in global terminalGroups order */
  terminalGroups: TerminalGroup[];
}

export function findTerminalAncestry(terminalId: string): TerminalAncestry | null {
  for (const conn of connections) {
    for (const project of conn.projects) {
      const terminal = project.terminals.find(t => t.id === terminalId);
      if (terminal) {
        return {
          conn,
          projectGroup: null,
          project,
          terminal,
          terminalGroups: terminalGroups.filter(g => g.terminalIds.includes(terminalId)),
        };
      }
    }
    if (conn.projectGroups) {
      for (const projectGroup of conn.projectGroups) {
        for (const project of projectGroup.projects) {
          const terminal = project.terminals.find(t => t.id === terminalId);
          if (terminal) {
            return {
              conn,
              projectGroup,
              project,
              terminal,
              terminalGroups: terminalGroups.filter(g => g.terminalIds.includes(terminalId)),
            };
          }
        }
      }
    }
  }
  return null;
}

export function findTerminalById(terminalId: string): { conn: Connection; project: Project; terminal: TerminalTab } | null {
  const a = findTerminalAncestry(terminalId);
  return a ? { conn: a.conn, project: a.project, terminal: a.terminal } : null;
}

export function getWsUrlForTerminal(terminalId: string): string | null {
  const found = findTerminalById(terminalId);
  return found?.conn.wsUrl ?? null;
}

// --- Hierarchical Variables ---

export type VariableOwnerKind =
  | 'connection'
  | 'projectGroup'
  | 'project'
  | 'terminal'
  | 'terminalGroup';

export type VariableOwnerRef =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'projectGroup'; connectionId: string; projectGroupId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'terminalGroup'; terminalGroupId: string };

export interface VariableSourceEntry {
  key: string;
  value: string;
  source:
    | { kind: 'connection'; id: string; name: string }
    | { kind: 'projectGroup'; id: string; name: string }
    | { kind: 'project'; id: string; name: string }
    | { kind: 'terminalGroup'; id: string; name: string }
    | { kind: 'terminal'; id: string; name: string }
    | { kind: 'context' };
}

function getOwnerNode(ref: VariableOwnerRef): { variables: NodeVariables; saveFn: () => void } | null {
  switch (ref.kind) {
    case 'connection': {
      const conn = connections.find(c => c.id === ref.connectionId);
      if (!conn) return null;
      if (!conn.variables) conn.variables = {};
      return { variables: conn.variables, saveFn: save };
    }
    case 'projectGroup': {
      const conn = connections.find(c => c.id === ref.connectionId);
      const pg = conn?.projectGroups?.find(g => g.id === ref.projectGroupId);
      if (!pg) return null;
      if (!pg.variables) pg.variables = {};
      return { variables: pg.variables, saveFn: save };
    }
    case 'project': {
      const found = findProjectById(ref.projectId);
      if (!found) return null;
      if (!found.project.variables) found.project.variables = {};
      return { variables: found.project.variables, saveFn: save };
    }
    case 'terminal': {
      const found = findTerminalById(ref.terminalId);
      if (!found) return null;
      if (!found.terminal.variables) found.terminal.variables = {};
      return { variables: found.terminal.variables, saveFn: save };
    }
    case 'terminalGroup': {
      const g = terminalGroups.find(x => x.id === ref.terminalGroupId);
      if (!g) return null;
      if (!g.variables) g.variables = {};
      return { variables: g.variables, saveFn: saveGroups };
    }
  }
}

export function getOwnVariables(ref: VariableOwnerRef): NodeVariables {
  const node = getOwnerNode(ref);
  if (!node) return {};
  return { ...node.variables };
}

export function setVariable(
  ref: VariableOwnerRef,
  key: string,
  value: string
): { ok: true } | { ok: false; error: string } {
  if (!isValidUserKey(key) || isDangerousKey(key)) {
    return { ok: false, error: `Invalid variable key: ${key}` };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'Variable value must be a string' };
  }
  const node = getOwnerNode(ref);
  if (!node) return { ok: false, error: 'Owner not found' };
  node.variables[key] = value;
  node.saveFn();
  return { ok: true };
}

export function removeVariable(ref: VariableOwnerRef, key: string): void {
  const node = getOwnerNode(ref);
  if (!node) return;
  delete node.variables[key];
  node.saveFn();
}

export function renameVariableKey(
  ref: VariableOwnerRef,
  oldKey: string,
  newKey: string
): { ok: true; referenceCount: number } | { ok: false; error: string } {
  if (!isValidUserKey(newKey) || isDangerousKey(newKey)) {
    return { ok: false, error: `Invalid variable key: ${newKey}` };
  }
  const node = getOwnerNode(ref);
  if (!node) return { ok: false, error: 'Owner not found' };
  if (!(oldKey in node.variables)) {
    return { ok: false, error: `Key not found: ${oldKey}` };
  }
  if (oldKey !== newKey && newKey in node.variables) {
    return { ok: false, error: `Key already exists: ${newKey}` };
  }
  const referenceCount = countVariableReferencesInScope(ref, oldKey);
  const val = node.variables[oldKey];
  delete node.variables[oldKey];
  node.variables[newKey] = val;
  node.saveFn();
  return { ok: true, referenceCount };
}

export function ancestryToLayers(a: TerminalAncestry): NodeVariables[] {
  const layers: NodeVariables[] = [a.conn.variables ?? {}];
  if (a.projectGroup) layers.push(a.projectGroup.variables ?? {});
  layers.push(a.project.variables ?? {});
  for (const g of a.terminalGroups) layers.push(g.variables ?? {});
  layers.push(a.terminal.variables ?? {});
  return layers;
}

export function ancestryToContextSource(a: TerminalAncestry) {
  return {
    terminalName: a.terminal.name,
    terminalId: a.terminal.id,
    tmuxSession: a.terminal.tmuxSession,
    workingDir: a.terminal.workingDir || '',
    projectName: a.project.name,
    projectId: a.project.id,
    projectGroupName: a.projectGroup?.name ?? '',
    projectGroupId: a.projectGroup?.id ?? '',
    connectionName: a.conn.name,
    connectionId: a.conn.id,
    connectionWsUrl: a.conn.wsUrl,
  };
}

export function getEffectiveVariablesForTerminal(terminalId: string): Map<string, string> | null {
  const a = findTerminalAncestry(terminalId);
  if (!a) return null;
  return buildScopeMap(ancestryToLayers(a), buildContextVars(ancestryToContextSource(a)));
}

export function resolveCommandForTerminal(
  terminalId: string,
  commandTemplate: string
): ResolveResult {
  const scope = getEffectiveVariablesForTerminal(terminalId);
  if (!scope) {
    return {
      ok: false,
      error: 'Unresolved variable(s): (terminal not found)',
      errorKind: 'unresolved',
      unresolved: [],
    };
  }
  return resolveTemplate(commandTemplate, scope);
}

export function getInheritedVariableEntries(ref: VariableOwnerRef): VariableSourceEntry[] {
  const entries: VariableSourceEntry[] = [];
  const pushLayer = (
    vars: NodeVariables | undefined,
    source: VariableSourceEntry['source']
  ) => {
    for (const [key, value] of Object.entries(vars ?? {})) {
      entries.push({ key, value, source });
    }
  };

  switch (ref.kind) {
    case 'connection':
    case 'terminalGroup':
      return [];
    case 'projectGroup': {
      const conn = connections.find(c => c.id === ref.connectionId);
      if (conn) pushLayer(conn.variables, { kind: 'connection', id: conn.id, name: conn.name });
      return entries;
    }
    case 'project': {
      const found = findProjectById(ref.projectId);
      if (!found) return [];
      pushLayer(found.conn.variables, { kind: 'connection', id: found.conn.id, name: found.conn.name });
      if (found.group) {
        pushLayer(found.group.variables, { kind: 'projectGroup', id: found.group.id, name: found.group.name });
      }
      return entries;
    }
    case 'terminal': {
      const a = findTerminalAncestry(ref.terminalId);
      if (!a) return [];
      pushLayer(a.conn.variables, { kind: 'connection', id: a.conn.id, name: a.conn.name });
      if (a.projectGroup) {
        pushLayer(a.projectGroup.variables, {
          kind: 'projectGroup',
          id: a.projectGroup.id,
          name: a.projectGroup.name,
        });
      }
      pushLayer(a.project.variables, { kind: 'project', id: a.project.id, name: a.project.name });
      for (const g of a.terminalGroups) {
        pushLayer(g.variables, { kind: 'terminalGroup', id: g.id, name: g.name });
      }
      return entries;
    }
  }
}

export function getEffectiveVariableEntries(terminalId: string): VariableSourceEntry[] {
  const a = findTerminalAncestry(terminalId);
  if (!a) return [];
  const entries = getInheritedVariableEntries({ kind: 'terminal', terminalId });
  for (const [key, value] of Object.entries(a.terminal.variables ?? {})) {
    entries.push({
      key,
      value,
      source: { kind: 'terminal', id: a.terminal.id, name: a.terminal.name },
    });
  }
  const ctx = buildContextVars(ancestryToContextSource(a));
  for (const [key, value] of Object.entries(ctx)) {
    entries.push({ key, value, source: { kind: 'context' } });
  }
  return entries;
}

/** Enumerate terminals whose commands are in rewrite scope for ref. */
export function terminalsInRewriteScope(scopeRef: VariableOwnerRef): TerminalAncestry[] {
  const out: TerminalAncestry[] = [];
  const visit = (terminalId: string) => {
    const a = findTerminalAncestry(terminalId);
    if (a) out.push(a);
  };

  switch (scopeRef.kind) {
    case 'connection': {
      const conn = connections.find(c => c.id === scopeRef.connectionId);
      if (!conn) return [];
      for (const p of conn.projects) for (const t of p.terminals) visit(t.id);
      for (const pg of conn.projectGroups || []) {
        for (const p of pg.projects) for (const t of p.terminals) visit(t.id);
      }
      break;
    }
    case 'projectGroup': {
      const conn = connections.find(c => c.id === scopeRef.connectionId);
      const pg = conn?.projectGroups?.find(g => g.id === scopeRef.projectGroupId);
      if (!pg) return [];
      for (const p of pg.projects) for (const t of p.terminals) visit(t.id);
      break;
    }
    case 'project': {
      const found = findProjectById(scopeRef.projectId);
      if (!found) return [];
      for (const t of found.project.terminals) visit(t.id);
      break;
    }
    case 'terminal': {
      visit(scopeRef.terminalId);
      break;
    }
    case 'terminalGroup': {
      const g = terminalGroups.find(x => x.id === scopeRef.terminalGroupId);
      if (!g) return [];
      for (const id of g.terminalIds) visit(id);
      break;
    }
  }
  return out;
}

export function terminalInRewriteScope(scopeRef: VariableOwnerRef, terminalId: string): boolean {
  return terminalsInRewriteScope(scopeRef).some(a => a.terminal.id === terminalId);
}

export function countVariableReferencesInScope(ref: VariableOwnerRef, key: string): number {
  let count = 0;
  for (const a of terminalsInRewriteScope(ref)) {
    for (const cmd of a.terminal.savedCommands || []) {
      count += countKeyReferences(cmd.command, key);
    }
  }
  return count;
}

// --- Text replacement ---

export interface TextReplaceMatch {
  terminalId: string;
  terminalName: string;
  commandId: string;
  commandLabel: string;
  before: string;
  after: string;
}

export interface TextReplacePreview {
  ok: true;
  find: string;
  mode: 'literal' | 'toVariable';
  replaceAll: boolean;
  variableKey?: string;
  scopeRef: VariableOwnerRef;
  ensureVariable: boolean;
  ensureValue?: string;
  matches: TextReplaceMatch[];
  skipped: { commandId: string; terminalId: string; reason: string }[];
  totalMatchCount: number;
}

export type TextReplacePreviewResult =
  | TextReplacePreview
  | { ok: false; error: string };

function inScopeForToVariable(
  terminalId: string,
  key: string,
  ensureVariable: boolean,
  scopeRef: VariableOwnerRef
): boolean {
  const effective = getEffectiveVariablesForTerminal(terminalId);
  if (effective?.has(key)) return true;
  if (ensureVariable && terminalInRewriteScope(scopeRef, terminalId)) {
    return true;
  }
  return false;
}

export function previewCommandTextReplace(options: {
  scopeRef: VariableOwnerRef;
  find: string;
  mode: 'literal' | 'toVariable';
  replace?: string;
  replaceAll?: boolean;
  variableKey?: string;
  ensureVariable?: boolean;
  requireInScope?: boolean;
}): TextReplacePreviewResult {
  const {
    scopeRef,
    find,
    mode,
    replace = '',
    replaceAll = true,
    variableKey,
    ensureVariable = false,
    requireInScope = true,
  } = options;

  if (!find) {
    return { ok: false, error: 'Find string must not be empty' };
  }

  let replacement = replace;
  if (mode === 'toVariable') {
    if (!variableKey) {
      return { ok: false, error: 'variableKey is required for toVariable mode' };
    }
    if (!isValidUserKey(variableKey) || isDangerousKey(variableKey)) {
      return { ok: false, error: `Invalid variable key: ${variableKey}` };
    }
    replacement = `\${${variableKey}}`;
  }

  const matches: TextReplaceMatch[] = [];
  const skipped: { commandId: string; terminalId: string; reason: string }[] = [];
  let totalMatchCount = 0;

  for (const a of terminalsInRewriteScope(scopeRef)) {
    for (const cmd of a.terminal.savedCommands || []) {
      const occ = countLiteralOccurrences(cmd.command, find);
      if (occ === 0) continue;

      if (mode === 'toVariable' && requireInScope) {
        const key = variableKey!;
        if (!inScopeForToVariable(a.terminal.id, key, ensureVariable, scopeRef)) {
          skipped.push({
            commandId: cmd.id,
            terminalId: a.terminal.id,
            reason: `Variable ${key} not in scope`,
          });
          continue;
        }
      }

      totalMatchCount += occ;
      const after = applyLiteralReplace(cmd.command, find, replacement, replaceAll);
      matches.push({
        terminalId: a.terminal.id,
        terminalName: a.terminal.name,
        commandId: cmd.id,
        commandLabel: cmd.label,
        before: cmd.command,
        after,
      });
    }
  }

  return {
    ok: true,
    find,
    mode,
    replaceAll,
    variableKey: mode === 'toVariable' ? variableKey : undefined,
    scopeRef,
    ensureVariable: mode === 'toVariable' ? ensureVariable : false,
    ensureValue: mode === 'toVariable' && ensureVariable ? find : undefined,
    matches,
    skipped,
    totalMatchCount,
  };
}

export function applyCommandTextReplace(preview: TextReplacePreview): {
  applied: number;
  skippedStale: number;
  ensured: boolean;
} {
  let applied = 0;
  let skippedStale = 0;
  let ensured = false;

  if (preview.ensureVariable && preview.variableKey && preview.ensureValue !== undefined) {
    const r = setVariable(preview.scopeRef, preview.variableKey, preview.ensureValue);
    ensured = r.ok;
  }

  for (const m of preview.matches) {
    const found = findTerminalById(m.terminalId);
    if (!found) {
      skippedStale += 1;
      continue;
    }
    const cmd = found.terminal.savedCommands.find(c => c.id === m.commandId);
    if (!cmd || cmd.command !== m.before) {
      skippedStale += 1;
      continue;
    }
    cmd.command = m.after;
    applied += 1;
  }

  if (applied > 0 || ensured) save();
  return { applied, skippedStale, ensured };
}

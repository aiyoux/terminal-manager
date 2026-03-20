// Hierarchical state store: Connection → Project → Terminal
// Persisted to IndexedDB

import { loadConnections, saveConnections, loadTerminalGroups, saveTerminalGroups, loadGridSettings, saveGridSettings } from './db';

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
  // Legacy compat: startupCommand is derived from savedCommands
}

export interface Project {
  id: string;
  name: string;
  terminals: TerminalTab[];
  collapsed: boolean;
}

export interface Connection {
  id: string;
  name: string;
  wsUrl: string;
  projects: Project[];
  collapsed: boolean;
}

export interface TerminalGroup {
  id: string;
  name: string;
  terminalIds: string[];
  collapsed: boolean;
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
  return t as TerminalTab;
}

// Load from IndexedDB on init
if (typeof window !== 'undefined') {
  Promise.all([
    loadConnections<Connection[]>(),
    loadTerminalGroups<TerminalGroup[]>(),
    loadGridSettings<GridSettings>()
  ]).then(([connData, groupData, gridData]) => {
    if (connData) {
      // Run migration
      for (const conn of connData) {
        for (const proj of conn.projects) {
          proj.terminals = proj.terminals.map(migrateTerminal);
        }
      }
      connections = connData;
    }
    if (groupData) {
      terminalGroups = groupData;
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
      if (!conn.id || !conn.name || !Array.isArray(conn.projects)) return false;
      for (const proj of conn.projects) {
        if (!proj.id || !proj.name || !Array.isArray(proj.terminals)) return false;
        proj.terminals = proj.terminals.map(migrateTerminal);
      }
    }

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
  if (toIndex < 0 || toIndex >= arr.length) return;
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

export function reorderSavedCommands(connId: string, projectId: string, terminalId: string, fromIndex: number, toIndex: number) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (terminal) {
    moveItem(terminal.savedCommands, fromIndex, toIndex);
    save();
  }
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
    collapsed: false
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

export function addProject(connId: string, name: string): Project | null {
  const conn = connections.find(c => c.id === connId);
  if (!conn) return null;

  const project: Project = {
    id: uid(),
    name,
    terminals: [],
    collapsed: false
  };
  conn.projects.push(project);
  save();
  return project;
}

export function removeProject(connId: string, projectId: string) {
  const conn = connections.find(c => c.id === connId);
  if (!conn) return;
  const idx = conn.projects.findIndex(p => p.id === projectId);
  if (idx > -1) conn.projects.splice(idx, 1);

  if (!findTerminalById(activeTerminalId)) {
    activeTerminalId = '';
  }
  save();
}

export function toggleProjectCollapse(connId: string, projectId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  if (project) project.collapsed = !project.collapsed;
  save();
}

// --- Terminal CRUD ---

export function addTerminal(connId: string, projectId: string, name: string): TerminalTab | null {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  if (!project) return null;

  const id = uid();
  const terminal: TerminalTab = {
    id,
    name,
    tmuxSession: `td-${id}`,
    workingDir: '',
    fontSize: 14,
    savedCommands: [],
    collapsed: true,
  };
  project.terminals.push(terminal);
  activeTerminalId = terminal.id;
  save();
  return terminal;
}

export function removeTerminal(connId: string, projectId: string, terminalId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  if (!project) return;

  const idx = project.terminals.findIndex(t => t.id === terminalId);
  if (idx > -1) project.terminals.splice(idx, 1);

  if (activeTerminalId === terminalId) {
    activeTerminalId = '';
  }
  save();
}

export function renameProject(connId: string, projectId: string, name: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  if (project) project.name = name;
  save();
}

export function renameTerminal(connId: string, projectId: string, terminalId: string, name: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (terminal) terminal.name = name;
  save();
}

export function toggleTerminalCollapse(connId: string, projectId: string, terminalId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (terminal) terminal.collapsed = !terminal.collapsed;
  save();
}

export function toggleTerminalPinned(connId: string, projectId: string, terminalId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (terminal) terminal.pinned = !terminal.pinned;
  save();
}

export function toggleTerminalGridHidden(connId: string, projectId: string, terminalId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (terminal) terminal.gridHidden = !terminal.gridHidden;
  save();
}

export function getGridSettings(): GridSettings {
  return gridSettings;
}

export function setGridLayout(columns: number, rows: number) {
  gridSettings = { columns, rows };
  saveGridSettings($state.snapshot(gridSettings));
}

export function updateTerminalFontSize(connId: string, projectId: string, terminalId: string, fontSize: number) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (terminal) terminal.fontSize = fontSize;
  save();
}

// --- Saved Command CRUD ---

export function addSavedCommand(connId: string, projectId: string, terminalId: string, label: string, command: string, autoExecute: boolean = true, sendCtrlCBefore: boolean = false): SavedCommand | null {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (!terminal) return null;

  const cmd: SavedCommand = {
    id: uid(),
    label,
    command,
    isOnConnect: false,
    autoExecute,
    sendCtrlCBefore,
  };
  terminal.savedCommands.push(cmd);
  save();
  return cmd;
}

export function removeSavedCommand(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (!terminal) return;

  const idx = terminal.savedCommands.findIndex(c => c.id === cmdId);
  if (idx > -1) terminal.savedCommands.splice(idx, 1);
  save();
}

export function updateSavedCommand(connId: string, projectId: string, terminalId: string, cmdId: string, newLabel: string, newCommand: string, autoExecute?: boolean, sendCtrlCBefore?: boolean) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) {
    cmd.label = newLabel;
    cmd.command = newCommand;
    if (autoExecute !== undefined) cmd.autoExecute = autoExecute;
    if (sendCtrlCBefore !== undefined) cmd.sendCtrlCBefore = sendCtrlCBefore;
    save();
  }
}

export function toggleCommandAutoExecute(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) {
    cmd.autoExecute = cmd.autoExecute === false ? true : false;
    save();
  }
}

export function toggleCommandCtrlCBefore(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) {
    cmd.sendCtrlCBefore = !cmd.sendCtrlCBefore;
    save();
  }
}

export function toggleCommandOnConnect(connId: string, projectId: string, terminalId: string, cmdId: string) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (!terminal) return;

  const cmd = terminal.savedCommands.find(c => c.id === cmdId);
  if (cmd) cmd.isOnConnect = !cmd.isOnConnect;
  save();
}

export function getOnConnectCommands(terminalId: string): string[] {
  const found = findTerminalById(terminalId);
  if (!found) return [];
  return found.terminal.savedCommands
    .filter(c => c.isOnConnect)
    .map(c => c.command);
}

// Legacy compat
export function updateTerminalConfig(connId: string, projectId: string, terminalId: string, config: { name?: string; workingDir?: string; startupCommand?: string }) {
  const conn = connections.find(c => c.id === connId);
  const project = conn?.projects.find(p => p.id === projectId);
  const terminal = project?.terminals.find(t => t.id === terminalId);
  if (!terminal) return;
  if (config.name !== undefined) terminal.name = config.name;
  if (config.workingDir !== undefined) terminal.workingDir = config.workingDir;
  save();
}

// --- Helpers ---

export function findTerminalById(terminalId: string): { conn: Connection; project: Project; terminal: TerminalTab } | null {
  for (const conn of connections) {
    for (const project of conn.projects) {
      const terminal = project.terminals.find(t => t.id === terminalId);
      if (terminal) return { conn, project, terminal };
    }
  }
  return null;
}

export function getWsUrlForTerminal(terminalId: string): string | null {
  const found = findTerminalById(terminalId);
  return found?.conn.wsUrl ?? null;
}

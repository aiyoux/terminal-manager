<script lang="ts">
  import Terminal from '$lib/components/Terminal.svelte';
  import { closeConnection, sendInput, isConnected, reconnectConnection, connectionStatuses } from '$lib/connectionManager';
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
    removeTerminal,
    toggleTerminalCollapse,
    toggleTerminalGridHidden,
    addSavedCommand,
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
    reorderSavedCommands,
    addTerminalGroup,
    removeTerminalGroup,
    toggleGroupCollapse,
    addTerminalToGroup,
    removeTerminalFromGroup,
    reorderGroups,
    reorderGroupTerminals,
    getGridSettings,
    setGridLayout,
    toggleTerminalPinned,
    type Connection,
    type Project,
    type ProjectGroup,
    type TerminalTab,
    type SavedCommand,
    type TerminalGroup,
  } from '$lib/stores.svelte';

  let connections = $derived(getConnections());
  let terminalGroups = $derived(getTerminalGroups());
  let activeTerminalId = $derived(getActiveTerminalId());
  let activeWsUrl = $derived(getWsUrlForTerminal(activeTerminalId));

  let activeSidebarTab = $state<'connections' | 'groups' | 'pinned'>('connections');

  // --- Drag and Drop ---
  let draggedItem = $state<{ type: 'connection' | 'project' | 'project-group' | 'terminal' | 'command' | 'group' | 'group-terminal'; id: string; index: number; connId?: string; projectId?: string; terminalId?: string; groupId?: string } | null>(null);
  let dragOverItem = $state<{ type: string; id: string; index: number } | null>(null);

  function handleDragStart(e: DragEvent, type: any, id: string, index: number, connId?: string, projectId?: string, terminalId?: string, groupId?: string) {
    e.stopPropagation();
    draggedItem = { type, id, index, connId, projectId, terminalId, groupId };
  }

  function handleDragOver(e: DragEvent, type: string, id: string, index: number) {
    e.stopPropagation();
    if (!draggedItem || draggedItem.type !== type) return;
    e.preventDefault();
    dragOverItem = { type, id, index };
  }

  function handleDrop(e: DragEvent, type: string, toIndex: number, targetConnId?: string, targetGroupId?: string) {
    e.stopPropagation();
    if (!draggedItem || draggedItem.type !== type) return;
    const fromIndex = draggedItem.index;

    if (type === 'connection') {
      if (fromIndex === toIndex) return;
      reorderConnections(fromIndex, toIndex);
    } else if (type === 'project' && draggedItem.connId) {
      const destConnId = targetConnId || draggedItem.connId;
      const destGroupId = targetGroupId || null;
      moveProject(draggedItem.id, destConnId, destGroupId, toIndex);
    } else if (type === 'project-group' && draggedItem.connId) {
      if (fromIndex === toIndex) return;
      reorderProjectGroups(draggedItem.connId, fromIndex, toIndex);
    } else if (type === 'terminal' && draggedItem.connId && draggedItem.projectId) {
      if (fromIndex === toIndex) return;
      reorderTerminals(draggedItem.projectId, fromIndex, toIndex);
    } else if (type === 'command' && draggedItem.connId && draggedItem.projectId && draggedItem.terminalId) {
      if (fromIndex === toIndex) return;
      reorderSavedCommands(draggedItem.terminalId, fromIndex, toIndex);
    } else if (type === 'group') {
      if (fromIndex === toIndex) return;
      reorderGroups(fromIndex, toIndex);
    } else if (type === 'group-terminal' && draggedItem.groupId) {
      if (fromIndex === toIndex) return;
      reorderGroupTerminals(draggedItem.groupId, fromIndex, toIndex);
    }

    draggedItem = null;
    dragOverItem = null;
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

  function startSidebarResize(e: MouseEvent) {
    e.preventDefault();
    isResizingSidebar = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    function onMouseMove(e: MouseEvent) {
      const newWidth = Math.max(200, Math.min(600, startWidth + (e.clientX - startX)));
      sidebarWidth = newWidth;
    }

    function onMouseUp() {
      isResizingSidebar = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  // Grid view state
  let gridViewConnId = $state<string>('');
  let gridViewProjectId = $state<string>('');

  // Global grid layout config
  let currentGridConfig = $derived(getGridSettings());

  // Track which terminals are mounted
  let mountedTerminalIds = $state<Set<string>>(new Set());

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

  // Auto-mount terminal when it becomes active
  $effect(() => {
    if (activeTerminalId && !mountedTerminalIds.has(activeTerminalId)) {
      mountedTerminalIds.add(activeTerminalId);
      mountedTerminalIds = new Set(mountedTerminalIds);
    }
  });

  // Auto-mount pinned terminals when in pinned view
  $effect(() => {
    if (gridViewConnId === '__pinned__') {
      let changed = false;
      for (const t of pinnedTerminals) {
        if (!mountedTerminalIds.has(t.id)) {
          mountedTerminalIds.add(t.id);
          changed = true;
        }
      }
      if (changed) mountedTerminalIds = new Set(mountedTerminalIds);
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

  async function showConfirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      dialogState = {
        isOpen: true,
        type: 'confirm',
        title: 'Confirm',
        message,
        value: '',
        placeholder: '',
        resolve
      };
    });
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
    if (await showConfirm('Remove this group? Terminals will not be deleted.')) {
      removeTerminalGroup(groupId);
      if (gridViewConnId === 'group' && gridViewProjectId === groupId) {
        gridViewConnId = '';
        gridViewProjectId = '';
      }
    }
  }

  function handleRemoveTerminalFromGroup(groupId: string, terminalId: string, e: Event) {
    e.stopPropagation();
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
    if (await showConfirm('Remove this project group and all its projects/terminals?')) {
      removeProjectGroup(connId, groupId);
    }
  }

  async function handleAddTerminal(connId: string, projectId: string) {
    const name = await showPrompt('Terminal name:', 'Terminal') || 'Terminal';
    addTerminal(connId, projectId, name);
  }

  async function handleRemoveConnection(connId: string, e: Event) {
    e.stopPropagation();
    if (await showConfirm('Remove this connection and all its projects/terminals?')) {
      removeConnection(connId);
    }
  }

  async function handleRemoveProject(connId: string, projectId: string, e: Event) {
    e.stopPropagation();
    if (await showConfirm('Remove this project and all its terminals?')) {
      removeProject(connId, projectId);
    }
  }

  function handleRemoveTerminal(connId: string, projectId: string, terminalId: string, e: Event) {
    e.stopPropagation();
    removeTerminal(connId, projectId, terminalId);
    mountedTerminalIds.delete(terminalId);
    mountedTerminalIds = new Set(mountedTerminalIds);
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

  function handleRunCommand(terminalId: string, command: string, autoExecute: boolean, sendCtrlCBefore: boolean, e: Event) {
    e.stopPropagation();
    if (sendCtrlCBefore) {
      sendInput(terminalId, '\x03');
      setTimeout(() => {
        sendInput(terminalId, autoExecute ? command + '\n' : command);
      }, 100);
    } else {
      sendInput(terminalId, autoExecute ? command + '\n' : command);
    }
  }

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
        title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
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
          title="Export Settings"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-sky-400 hover:bg-sky-500/10 transition-all active:scale-95 group"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover:translate-y-[-1px] transition-transform"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          EXPORT
        </button>
        <button
          onclick={() => fileInput.click()}
          title="Import Settings"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-all active:scale-95 group"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover:translate-y-[-1px] transition-transform"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          IMPORT
        </button>
        <input type="file" bind:this={fileInput} onchange={handleImport} accept=".json" class="hidden" />
      </div>

      <div class="w-px h-4 bg-white/5 mr-1"></div>
      <div class="flex items-center gap-1.5">
        <label class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-violet-400 hover:bg-violet-500/10 transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          <span>COLS</span>
          <input
            type="number"
            min="0"
            max="12"
            value={currentGridConfig.columns || ''}
            placeholder="Auto"
            class="w-10 bg-transparent border-b border-white/10 text-[11px] font-semibold text-slate-300 text-center focus:outline-none focus:border-violet-400 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            oninput={(e) => {
              const val = parseInt((e.target as HTMLInputElement).value) || 0;
              setGridLayout(val, currentGridConfig.rows);
            }}
          />
        </label>
        <label class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold tracking-wide text-slate-400 hover:text-violet-400 hover:bg-violet-500/10 transition-all">
          <span>ROWS</span>
          <input
            type="number"
            min="0"
            max="12"
            value={currentGridConfig.rows || ''}
            placeholder="Auto"
            class="w-10 bg-transparent border-b border-white/10 text-[11px] font-semibold text-slate-300 text-center focus:outline-none focus:border-violet-400 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            oninput={(e) => {
              const val = parseInt((e.target as HTMLInputElement).value) || 0;
              setGridLayout(currentGridConfig.columns, val);
            }}
          />
        </label>
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
      class="flex flex-col border-r border-white/5 bg-slate-950 shrink-0 transition-[width,opacity] duration-200 overflow-hidden"
      style="width: {sidebarOpen ? sidebarWidth + 'px' : '0px'}; opacity: {sidebarOpen ? 1 : 0};"
    >
      <div class="flex items-center border-b border-white/5 p-2 gap-1">
        <button
          class="flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors {activeSidebarTab === 'connections' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}"
          onclick={() => { activeSidebarTab = 'connections'; if (gridViewConnId === '__pinned__') { gridViewConnId = ''; gridViewProjectId = ''; } }}
        >
          Connections
        </button>
        <button
          class="flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors {activeSidebarTab === 'groups' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}"
          onclick={() => { activeSidebarTab = 'groups'; if (gridViewConnId === '__pinned__') { gridViewConnId = ''; gridViewProjectId = ''; } }}
        >
          Groups
        </button>
        <button
          class="flex-1 py-1.5 text-xs font-semibold rounded-md transition-colors {activeSidebarTab === 'pinned' ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}"
          onclick={() => {
            activeSidebarTab = 'pinned';
            gridViewProjectId = '__pinned__';
            gridViewConnId = '__pinned__';
            setActiveTerminalId('');
            for (const t of pinnedTerminals) mountedTerminalIds.add(t.id);
            mountedTerminalIds = new Set(mountedTerminalIds);
          }}
        >
          Pinned
        </button>
      </div>

      <div class="p-3 flex-1 min-h-0 overflow-y-auto">
        {#if activeSidebarTab === 'connections'}
          <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3 px-2">Connections</div>

          {#each connections as conn, connIdx (conn.id)}
            <div
              class="mb-2 transition-all {dragOverItem?.type === 'connection' && dragOverItem?.id === conn.id ? 'border-t-2 border-sky-500' : ''} {draggedItem?.type === 'connection' && draggedItem?.id === conn.id ? 'opacity-50' : ''} {dragOverItem?.type === 'project-conn-drop' && dragOverItem?.id === conn.id ? 'bg-sky-500/10 rounded-md ring-1 ring-sky-500/30' : ''}"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, 'connection', conn.id, connIdx)}
              ondragover={(e) => {
                if (draggedItem?.type === 'project') {
                  e.preventDefault();
                  dragOverItem = { type: 'project-conn-drop', id: conn.id, index: 0 };
                } else {
                  handleDragOver(e, 'connection', conn.id, connIdx);
                }
              }}
              ondrop={(e) => {
                if (draggedItem?.type === 'project') {
                  handleDrop(e, 'project', 0, conn.id);
                } else {
                  handleDrop(e, 'connection', connIdx);
                }
              }}
              ondragend={(e) => { e.stopPropagation(); draggedItem = null; dragOverItem = null; }}
            >
              <button class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:bg-white/5 group" onclick={() => toggleConnectionCollapse(conn.id)}>
                <div class="flex items-center gap-2 overflow-hidden">
                  <div class="cursor-grab active:cursor-grabbing p-0.5 text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                  </div>
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-sky-400 transition-transform {conn.collapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"/></svg>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-sky-400"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                  <span class="truncate text-slate-200">{conn.name}</span>
                </div>
                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div role="button" tabindex="0" title="Add Project Group" onclick={(e) => { e.stopPropagation(); handleAddProjectGroup(conn.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddProjectGroup(conn.id)} class="p-0.5 text-slate-500 hover:text-violet-400 rounded hover:bg-violet-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                  </div>
                  <div role="button" tabindex="0" title="Add Project" onclick={(e) => { e.stopPropagation(); handleAddProject(conn.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddProject(conn.id)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  </div>
                  <div role="button" tabindex="0" title="Remove Connection" onclick={(e) => handleRemoveConnection(conn.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveConnection(conn.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </div>
                </div>
              </button>

              {#if !conn.collapsed}
                <div class="ml-4 mt-1 border-l border-slate-800 pl-2">
                  <div class="text-[9px] uppercase tracking-widest text-slate-600 px-2 mb-1">{conn.wsUrl}</div>

                  {#snippet projectSnippet(connId, project, projIdx, groupId)}
                    <div
                      class="mb-1 transition-all {dragOverItem?.type === 'project' && dragOverItem?.id === project.id ? 'border-t-2 border-amber-500' : ''} {draggedItem?.type === 'project' && draggedItem?.id === project.id ? 'opacity-50' : ''}"
                      draggable="true"
                      ondragstart={(e) => handleDragStart(e, 'project', project.id, projIdx, connId, undefined, undefined, groupId)}
                      ondragover={(e) => handleDragOver(e, 'project', project.id, projIdx)}
                      ondrop={(e) => handleDrop(e, 'project', projIdx, connId, groupId)}
                      ondragend={(e) => { e.stopPropagation(); draggedItem = null; dragOverItem = null; }}
                    >
                      <button class="w-full flex items-center justify-between px-2 py-1 rounded-md text-xs transition-colors hover:bg-white/5 group" onclick={() => toggleProjectCollapse(connId, project.id)}>
                        <div class="flex items-center gap-2 overflow-hidden">
                          <div class="cursor-grab active:cursor-grabbing p-0.5 text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
                            <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                          </div>
                          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-amber-400 transition-transform {project.collapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"/></svg>
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-amber-400"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                          <span class="truncate text-slate-300">{project.name}</span>
                        </div>
                        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <div role="button" tabindex="0" title="Rename Project" onclick={(e) => handleRenameProject(connId, project.id, project.name, e)} onkeydown={(e) => e.key === 'Enter' && handleRenameProject(connId, project.id, project.name, e)} class="p-0.5 text-slate-500 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                          </div>
                          <div role="button" tabindex="0" title={gridViewProjectId === project.id ? 'Single View' : 'Grid View'} onclick={(e) => toggleGridView(connId, project.id, e)} onkeydown={(e) => e.key === 'Enter' && toggleGridView(connId, project.id, e)} class="p-0.5 rounded transition-colors {gridViewProjectId === project.id ? 'text-violet-400 bg-violet-500/20' : 'text-slate-500 hover:text-violet-400 hover:bg-violet-500/20'}">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                          </div>
                          <div role="button" tabindex="0" title="Add Terminal" onclick={(e) => { e.stopPropagation(); handleAddTerminal(connId, project.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddTerminal(connId, project.id)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                          </div>
                          <div role="button" tabindex="0" title="Remove Project" onclick={(e) => handleRemoveProject(connId, project.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveProject(connId, project.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </div>
                        </div>
                      </button>

                      {#if !project.collapsed}
                        <div class="ml-4 border-l border-slate-800/50 pl-2">
                          {#each project.terminals as terminal, termIdx (terminal.id)}
                            {@const isMounted = mountedTerminalIds.has(terminal.id)}
                            {@const isConn = !!connectionStatuses[terminal.id]}
                            <!-- Terminal row -->
                            <div
                              class="mb-0.5 transition-all {dragOverItem?.type === 'terminal' && dragOverItem?.id === terminal.id ? 'border-t-2 border-sky-400' : ''} {draggedItem?.type === 'terminal' && draggedItem?.id === terminal.id ? 'opacity-50' : ''}"
                              draggable="true"
                              ondragstart={(e) => handleDragStart(e, 'terminal', terminal.id, termIdx, connId, project.id)}
                              ondragover={(e) => handleDragOver(e, 'terminal', terminal.id, termIdx)}
                              ondrop={(e) => handleDrop(e, 'terminal', termIdx)}
                              ondragend={(e) => { e.stopPropagation(); draggedItem = null; dragOverItem = null; }}
                            >
                              <button
                                class="w-full flex items-center justify-between px-2 py-1 rounded-md text-xs transition-all group {activeTerminalId === terminal.id ? 'bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/30' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}"
                                onclick={() => handleSelectTerminal(terminal.id)}
                              >
                                <div class="flex items-center gap-1.5 overflow-hidden">
                                  <div class="cursor-grab active:cursor-grabbing p-0.5 text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                                  </div>
                                  <!-- Expand arrow for saved commands -->
                                  <div
                                    role="button" tabindex="0" title="Saved Commands"
                                    onclick={(e) => { e.stopPropagation(); toggleTerminalCollapse(connId, project.id, terminal.id); }}
                                    onkeydown={(e) => e.key === 'Enter' && toggleTerminalCollapse(connId, project.id, terminal.id)}
                                    class="shrink-0 p-0.5 -ml-0.5 hover:bg-white/10 rounded transition-colors"
                                  >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="transition-transform {terminal.collapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"/></svg>
                                  </div>
                                  <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${!isMounted ? 'bg-slate-600' : (isConn ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]')}`}></div>
                                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                                  <span class="truncate">{terminal.name}</span>
                                </div>
                                <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                                  <div role="button" tabindex="0" title={terminal.gridHidden ? 'Show in Grid' : 'Hide in Grid'} onclick={(e) => { e.stopPropagation(); toggleTerminalGridHidden(connId, project.id, terminal.id); }} onkeydown={(e) => e.key === 'Enter' && toggleTerminalGridHidden(connId, project.id, terminal.id)} class="p-0.5 rounded transition-colors {terminal.gridHidden ? 'text-slate-600 hover:text-slate-400' : 'text-sky-400 bg-sky-500/10 hover:bg-sky-500/20'}">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                      {#if terminal.gridHidden}
                                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>
                                      {:else}
                                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
                                      {/if}
                                    </svg>
                                  </div>
                                  {#if mountedTerminalIds.has(terminal.id)}
                                    <div role="button" tabindex="0" title="Disconnect" onclick={(e) => handleDisconnect(terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleDisconnect(terminal.id, e)} class="p-0.5 text-slate-500 hover:text-amber-400 rounded hover:bg-amber-500/20 transition-colors">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64A9 9 0 0 1 20.77 15"/><path d="M6.16 6.16a9 9 0 1 0 12.68 12.68"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                                    </div>
                                  {:else}
                                    <div role="button" tabindex="0" title="Reconnect" onclick={(e) => handleReconnect(terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleReconnect(terminal.id, e)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
                                    </div>
                                  {/if}
                                  <div role="button" tabindex="0" title="Rename" onclick={(e) => handleRenameTerminal(connId, project.id, terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRenameTerminal(connId, project.id, terminal.id, e)} class="p-0.5 text-slate-500 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                  </div>
                                  <div role="button" tabindex="0" title="Remove" onclick={(e) => handleRemoveTerminal(connId, project.id, terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveTerminal(connId, project.id, terminal.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                  </div>
                                </div>
                              </button>

                              <!-- Expanded: saved commands panel -->
                              {#if !terminal.collapsed}
                                <div class="ml-5 mt-1 mb-2 pl-2 border-l border-slate-700/50">
                                  <!-- Saved commands -->
                                  <div class="mt-1">
                                    <div class="flex items-center justify-between px-2">
                                      <span class="text-[9px] uppercase tracking-widest text-slate-600">Commands</span>
                                      <div
                                        role="button" tabindex="0" title="Add Command"
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
                                      {#each terminal.savedCommands as cmd, cmdIdx (cmd.id)}
                                        <div
                                          class="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-white/5 group/cmd text-[10px] transition-all {dragOverItem?.type === 'command' && dragOverItem?.id === cmd.id ? 'border-t-2 border-emerald-500' : ''} {draggedItem?.type === 'command' && draggedItem?.id === cmd.id ? 'opacity-50' : ''}"
                                          draggable="true"
                                          ondragstart={(e) => handleDragStart(e, 'command', cmd.id, cmdIdx, connId, project.id, terminal.id)}
                                          ondragover={(e) => handleDragOver(e, 'command', cmd.id, cmdIdx)}
                                          ondrop={(e) => handleDrop(e, 'command', cmdIdx)}
                                          ondragend={(e) => { e.stopPropagation(); draggedItem = null; dragOverItem = null; }}
                                        >
                                          <div class="cursor-grab active:cursor-grabbing p-0.5 text-slate-700 hover:text-slate-500 opacity-0 group-hover/cmd:opacity-100 transition-opacity">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                                          </div>
                                          <!-- On-connect toggle -->
                                          <button
                                            title={cmd.isOnConnect ? 'Auto-run on connect (click to disable)' : 'Click to auto-run on connect'}
                                            onclick={(e) => { e.stopPropagation(); toggleCommandOnConnect(connId, project.id, terminal.id, cmd.id); }}
                                            class="shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors {cmd.isOnConnect ? 'text-emerald-400 bg-emerald-500/20' : 'text-slate-600 hover:text-slate-400'}"
                                          >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                          </button>
                                          <!-- Auto-execute toggle -->
                                          <button
                                            title={cmd.autoExecute !== false ? 'Executes command (click to inject only)' : 'Injects text only (click to auto-execute)'}
                                            onclick={(e) => { e.stopPropagation(); toggleCommandAutoExecute(connId, project.id, terminal.id, cmd.id); }}
                                            class="shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors {cmd.autoExecute !== false ? 'text-sky-400 bg-sky-500/20' : 'text-amber-400 bg-amber-500/20'}"
                                          >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill={cmd.autoExecute !== false ? 'none' : 'currentColor'} stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">{#if cmd.autoExecute !== false}<polygon points="5 3 19 12 5 21 5 3"/>{:else}<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6"/><path d="M9 15h4"/>{/if}</svg>
                                          </button>
                                          <!-- Ctrl+C before toggle -->
                                          <button
                                            title={cmd.sendCtrlCBefore ? 'Sends Ctrl+C before running (click to disable)' : 'Click to send Ctrl+C before running'}
                                            onclick={(e) => { e.stopPropagation(); toggleCommandCtrlCBefore(connId, project.id, terminal.id, cmd.id); }}
                                            class="shrink-0 w-4 h-4 flex items-center justify-center rounded transition-colors {cmd.sendCtrlCBefore ? 'text-rose-400 bg-rose-500/20' : 'text-slate-600 hover:text-slate-400'}"
                                          >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                          </button>
                                          <!-- Run button -->
                                          <button
                                            title="{cmd.sendCtrlCBefore ? '(Ctrl+C) ' : ''}{cmd.autoExecute !== false ? 'Run' : 'Inject'}: {cmd.command}"
                                            onclick={(e) => handleRunCommand(terminal.id, cmd.command, cmd.autoExecute !== false, !!cmd.sendCtrlCBefore, e)}
                                            class="flex-1 text-left truncate text-slate-400 hover:text-white transition-colors px-1"
                                          >
                                            <span class="font-medium text-slate-300">{cmd.label}</span>
                                            <span class="text-slate-600 ml-1">→ {cmd.command}</span>
                                          </button>
                                          <!-- Edit -->
                                          <div
                                            role="button" tabindex="0" title="Edit Command"
                                            onclick={(e) => handleEditCommand(connId, project.id, terminal.id, cmd, e)}
                                            onkeydown={(e) => e.key === 'Enter' && handleEditCommand(connId, project.id, terminal.id, cmd, e)}
                                            class="shrink-0 p-0.5 text-slate-600 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors opacity-0 group-hover/cmd:opacity-100"
                                          >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                          </div>
                                          <!-- Remove -->
                                          <div
                                            role="button" tabindex="0" title="Remove Command"
                                            onclick={(e) => { e.stopPropagation(); removeSavedCommand(connId, project.id, terminal.id, cmd.id); }}
                                            onkeydown={(e) => e.key === 'Enter' && removeSavedCommand(connId, project.id, terminal.id, cmd.id)}
                                            class="shrink-0 p-0.5 text-slate-600 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors opacity-0 group-hover/cmd:opacity-100"
                                          >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
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
                        class="mb-1 transition-all {dragOverItem?.type === 'project-group' && dragOverItem?.id === group.id ? 'border-t-2 border-violet-500' : ''} {draggedItem?.type === 'project-group' && draggedItem?.id === group.id ? 'opacity-50' : ''} {dragOverItem?.type === 'project-group-drop' && dragOverItem?.id === group.id ? 'bg-violet-500/10 rounded-md ring-1 ring-violet-500/30' : ''}"
                        draggable="true"
                        ondragstart={(e) => handleDragStart(e, 'project-group', group.id, groupIdx, conn.id)}
                        ondragover={(e) => {
                          if (draggedItem?.type === 'project') {
                            e.preventDefault();
                            dragOverItem = { type: 'project-group-drop', id: group.id, index: 0 };
                          } else if (draggedItem?.type === 'project-group') {
                            handleDragOver(e, 'project-group', group.id, groupIdx);
                          }
                        }}
                        ondrop={(e) => {
                          if (draggedItem?.type === 'project') {
                            handleDrop(e, 'project', 0, conn.id, group.id);
                          } else if (draggedItem?.type === 'project-group') {
                            handleDrop(e, 'project-group', groupIdx, conn.id);
                          }
                        }}
                        ondragend={(e) => { e.stopPropagation(); draggedItem = null; dragOverItem = null; }}
                      >
                        <button class="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-white/5 group/pg" onclick={() => toggleProjectGroupCollapse(conn.id, group.id)}>
                          <div class="flex items-center gap-2 overflow-hidden">
                            <div class="cursor-grab active:cursor-grabbing p-0.5 text-slate-600 hover:text-slate-400 opacity-0 group-hover/pg:opacity-100 transition-opacity">
                              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                            </div>
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-violet-400 transition-transform {group.collapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"/></svg>
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-violet-400"><path d="M15.5 17.5H22a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L11.6 3.4a2 2 0 0 0-1.67-.9H4a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h1.5"/><path d="M5 17.5v3A2 2 0 0 0 7 22.5h15a2 2 0 0 0 2-2v-3"/></svg>
                            <span class="truncate font-medium text-slate-200">{group.name}</span>
                          </div>
                          <div class="flex items-center gap-1 opacity-0 group-hover/pg:opacity-100 transition-opacity">
                            <div role="button" tabindex="0" title="Rename Group" onclick={(e) => handleRenameProjectGroup(conn.id, group.id, group.name, e)} onkeydown={(e) => e.key === 'Enter' && handleRenameProjectGroup(conn.id, group.id, group.name, e)} class="p-0.5 text-slate-500 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                            </div>
                            <div role="button" tabindex="0" title="Add Project" onclick={(e) => { e.stopPropagation(); handleAddProject(conn.id, group.id); }} onkeydown={(e) => e.key === 'Enter' && handleAddProject(conn.id, group.id)} class="p-0.5 text-slate-500 hover:text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            </div>
                            <div role="button" tabindex="0" title="Remove Group" onclick={(e) => handleRemoveProjectGroup(conn.id, group.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveProjectGroup(conn.id, group.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </div>
                          </div>
                        </button>

                        {#if !group.collapsed}
                          <div class="ml-4 border-l border-violet-800/20 pl-2">
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
              class="mb-2 transition-all {dragOverItem?.type === 'group' && dragOverItem?.id === group.id ? 'border-t-2 border-indigo-500' : ''} {draggedItem?.type === 'group' && draggedItem?.id === group.id ? 'opacity-50' : ''}"
              draggable="true"
              ondragstart={(e) => handleDragStart(e, 'group', group.id, groupIdx)}
              ondragover={(e) => handleDragOver(e, 'group', group.id, groupIdx)}
              ondrop={(e) => handleDrop(e, 'group', groupIdx)}
              ondragend={(e) => { e.stopPropagation(); draggedItem = null; dragOverItem = null; }}
            >
              <button class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors hover:bg-white/5 group" onclick={() => toggleGroupCollapse(group.id)}>
                <div class="flex items-center gap-2 overflow-hidden">
                  <div class="cursor-grab active:cursor-grabbing p-0.5 text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                  </div>
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-indigo-400 transition-transform {group.collapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"/></svg>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-indigo-400"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  <span class="truncate text-slate-200">{group.name}</span>
                </div>
                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div role="button" tabindex="0" title={gridViewProjectId === group.id ? 'Single View' : 'Grid View'} onclick={(e) => toggleGridView('group', group.id, e)} onkeydown={(e) => e.key === 'Enter' && toggleGridView('group', group.id, e)} class="p-0.5 rounded transition-colors {gridViewProjectId === group.id ? 'text-violet-400 bg-violet-500/20' : 'text-slate-500 hover:text-violet-400 hover:bg-violet-500/20'}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                  </div>
                  <div role="button" tabindex="0" title="Remove Group" onclick={(e) => handleRemoveGroup(group.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveGroup(group.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </div>
                </div>
              </button>

              {#if !group.collapsed}
                <div class="ml-4 mt-1 border-l border-slate-800 pl-2">
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
                          class="mb-0.5 transition-all {dragOverItem?.type === 'group-terminal' && dragOverItem?.id === terminal.id ? 'border-t-2 border-indigo-400' : ''} {draggedItem?.type === 'group-terminal' && draggedItem?.id === terminal.id ? 'opacity-50' : ''}"
                          draggable="true"
                          ondragstart={(e) => handleDragStart(e, 'group-terminal', terminal.id, termIdx, undefined, undefined, terminal.id, group.id)}
                          ondragover={(e) => handleDragOver(e, 'group-terminal', terminal.id, termIdx)}
                          ondrop={(e) => handleDrop(e, 'group-terminal', termIdx)}
                          ondragend={(e) => { e.stopPropagation(); draggedItem = null; dragOverItem = null; }}
                        >
                          <button
                            class="w-full flex items-center justify-between px-2 py-1 rounded-md text-xs transition-all group {activeTerminalId === terminal.id ? 'bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/30' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}"
                            onclick={() => handleSelectTerminal(terminal.id)}
                          >
                            <div class="flex items-center gap-1.5 overflow-hidden">
                              <div class="cursor-grab active:cursor-grabbing p-0.5 text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
                                <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
                              </div>
                              <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${!isMounted ? 'bg-slate-600' : (isConn ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]')}`}></div>
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                              <span class="truncate">{terminal.name}</span>
                            </div>
                            <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                              <div role="button" tabindex="0" title="Remove from Group" onclick={(e) => handleRemoveTerminalFromGroup(group.id, terminal.id, e)} onkeydown={(e) => e.key === 'Enter' && handleRemoveTerminalFromGroup(group.id, terminal.id, e)} class="p-0.5 text-slate-500 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors">
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
                  class="w-full flex items-center justify-between px-2 py-1 rounded-md text-xs transition-all group {activeTerminalId === terminal.id ? 'bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/30' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}"
                  onclick={() => handleSelectTerminal(terminal.id)}
                >
                  <div class="flex items-center gap-1.5 overflow-hidden">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-amber-400"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
                    <div class={`w-1.5 h-1.5 rounded-full shrink-0 ${!isMounted ? 'bg-slate-600' : (isConn ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.5)]')}`}></div>
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                    <span class="truncate">{terminal.name}</span>
                  </div>
                  <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                    <div role="button" tabindex="0" title="Unpin" onclick={(e) => { e.stopPropagation(); toggleTerminalPinned(terminal.connId, terminal.projectId, terminal.id); }} onkeydown={(e) => e.key === 'Enter' && toggleTerminalPinned(terminal.connId, terminal.projectId, terminal.id)} class="p-0.5 text-amber-400 hover:text-amber-300 rounded hover:bg-amber-500/20 transition-colors">
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
          <button onclick={handleAddConnection} class="w-full py-2 border border-slate-700 border-dashed rounded-lg text-slate-400 hover:text-white hover:border-slate-500 hover:bg-white/5 transition-all text-xs flex items-center justify-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Connection
          </button>
        {:else if activeSidebarTab === 'groups'}
          <button onclick={handleAddGroup} class="w-full py-2 border border-indigo-700/50 border-dashed rounded-lg text-indigo-400 hover:text-indigo-300 hover:border-indigo-500 hover:bg-indigo-500/10 transition-all text-xs flex items-center justify-center gap-2">
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

    <!-- Terminal Workspace -->
    <div
      class="flex-1 min-w-0 bg-slate-900/30 p-3 relative"
      class:grid-mode={!!gridViewProjectId}
      class:overflow-hidden={!gridViewProjectId || !currentGridConfig.rows}
      class:overflow-y-auto={!!gridViewProjectId && !!currentGridConfig.rows}
      id="workspace"
      style={gridViewProjectId ? [
        currentGridConfig.columns ? `grid-template-columns: repeat(${currentGridConfig.columns}, 1fr);` : '',
        currentGridConfig.rows ? `--grid-row-height: calc((100vh - 3.5rem - 1.5rem - ${(currentGridConfig.rows - 1) * 0.75}rem) / ${currentGridConfig.rows}); grid-template-rows: repeat(${currentGridConfig.rows}, var(--grid-row-height)); grid-auto-rows: var(--grid-row-height);` : '',
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
                onAddToGroup={() => handleAddToGroupPrompt(t.id)}
                onTogglePin={() => toggleTerminalPinned(t.connId, t.projectId, t.id)}
              />            </div>
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

  <!-- Dialog -->
  {#if dialogState.isOpen}
    <div class="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div class="bg-slate-900 border border-white/10 rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div class="p-4 border-b border-white/5">
          <h3 class="text-sm font-semibold text-slate-200">{dialogState.title}</h3>
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
              onclick={handleDialogCancel}
              class="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-all"
            >
              Cancel
            </button>
          {/if}
          <button
            onclick={handleDialogSubmit}
            class="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-sky-500 hover:bg-sky-400 shadow-lg shadow-sky-500/20 transition-all"
          >
            {dialogState.type === 'prompt' || dialogState.type === 'command-prompt' ? 'Save' : (dialogState.type === 'confirm' ? 'Confirm' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  {/if}
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
    inset: 0.75rem;
    z-index: -10;
  }

  :global(.terminal-visible.terminal-single) {
    position: absolute;
    inset: 0.75rem;
  }

  :global(#workspace.grid-mode) {
    display: grid !important;
    grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    grid-auto-rows: minmax(0, 1fr);
    gap: 0.75rem;
  }

  :global(.terminal-visible.terminal-grid) {
    position: relative;
    min-height: 0;
    min-width: 0;
    height: 100%;
    width: 100%;
    overflow: hidden;
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

<script lang="ts">
  import {
    addSavedCommand,
    updateSavedCommand,
    removeSavedCommand,
    duplicateSavedCommand,
    toggleCommandOnConnect,
    toggleCommandAutoExecute,
    toggleCommandCtrlCBefore,
    type SavedCommand,
  } from '$lib/stores.svelte';

  let {
    connId,
    projectId,
    terminalId,
    savedCommands = [],
    onRun,
  }: {
    connId: string;
    projectId: string;
    terminalId: string;
    savedCommands?: SavedCommand[];
    onRun?: (command: string, autoExecute: boolean, sendCtrlCBefore: boolean) => void;
  } = $props();

  type FormMode = 'closed' | 'add' | 'edit';

  let formMode = $state<FormMode>('closed');
  let editingCmdId = $state<string | null>(null);
  let formLabel = $state('');
  let formCommand = $state('');
  let formOnConnect = $state(false);
  let formAutoExecute = $state(true);
  let formSendCtrlCBefore = $state(false);
  let pendingDeleteId = $state<string | null>(null);

  function openAdd() {
    formMode = 'add';
    editingCmdId = null;
    formLabel = '';
    formCommand = '';
    formOnConnect = false;
    formAutoExecute = true;
    formSendCtrlCBefore = false;
    pendingDeleteId = null;
  }

  function openEdit(cmd: SavedCommand) {
    formMode = 'edit';
    editingCmdId = cmd.id;
    formLabel = cmd.label;
    formCommand = cmd.command;
    formOnConnect = !!cmd.isOnConnect;
    formAutoExecute = cmd.autoExecute !== false;
    formSendCtrlCBefore = !!cmd.sendCtrlCBefore;
    pendingDeleteId = null;
  }

  function closeForm() {
    formMode = 'closed';
    editingCmdId = null;
  }

  function saveForm() {
    const label = formLabel.trim();
    const command = formCommand.trim();
    if (!label || !command) return;

    if (formMode === 'add') {
      addSavedCommand(connId, projectId, terminalId, label, command, formAutoExecute, formSendCtrlCBefore, formOnConnect);
    } else if (formMode === 'edit' && editingCmdId) {
      updateSavedCommand(connId, projectId, terminalId, editingCmdId, label, command, formAutoExecute, formSendCtrlCBefore, formOnConnect);
    }
    closeForm();
  }

  function confirmDelete(cmdId: string) {
    removeSavedCommand(connId, projectId, terminalId, cmdId);
    pendingDeleteId = null;
    if (editingCmdId === cmdId) closeForm();
  }
</script>

<div class="flex flex-col gap-2.5 min-w-[300px] max-w-[380px]">
  <div class="flex items-center justify-between gap-2">
    <span class="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">Command shortcuts</span>
    {#if formMode === 'closed'}
      <button
        type="button"
        onclick={openAdd}
        class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/15 transition-colors"
        data-tooltip="Add saved command shortcut"
        data-tooltip-pos="bottom-left"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add
      </button>
    {/if}
  </div>

  <!-- Legend for the three action settings -->
  <div class="flex flex-wrap items-center gap-1.5 px-1">
    <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[9px] font-medium border border-emerald-500/20">
      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      Auto-run
    </span>
    <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 text-[9px] font-medium border border-sky-500/20">
      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Hit Enter
    </span>
    <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 text-[9px] font-medium border border-rose-500/20">
      <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      Ctrl+C first
    </span>
  </div>

  {#if formMode !== 'closed'}
    <div class="flex flex-col gap-2 p-2.5 rounded-lg bg-slate-950/60 border border-white/10">
      <div class="text-[10px] font-semibold text-slate-300">
        {formMode === 'add' ? 'Add command' : 'Edit command'}
      </div>
      <input
        type="text"
        bind:value={formLabel}
        placeholder="Command label (e.g., Dev Server)"
        class="w-full bg-slate-900 border border-white/10 rounded-md px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/50"
        onkeydown={(e) => e.key === 'Enter' && saveForm()}
      />
      <input
        type="text"
        bind:value={formCommand}
        placeholder="Command (e.g., npm run dev)"
        class="w-full bg-slate-900 border border-white/10 rounded-md px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500/50 font-mono"
        onkeydown={(e) => e.key === 'Enter' && saveForm()}
      />

      <!-- Three action settings -->
      <div class="flex flex-col gap-1.5 pt-0.5">
        <label class="flex items-center gap-2 cursor-pointer select-none rounded-md px-1.5 py-1 hover:bg-white/5 transition-colors">
          <input
            type="checkbox"
            bind:checked={formOnConnect}
            class="w-3.5 h-3.5 rounded border-white/10 bg-slate-900 text-emerald-500 focus:ring-emerald-500/50 focus:ring-offset-0 cursor-pointer"
          />
          <span class="inline-flex items-center gap-1.5 text-[10px] text-slate-300">
            <span class="w-4 h-4 flex items-center justify-center rounded bg-emerald-500/15 text-emerald-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
            Auto-run on connect
          </span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer select-none rounded-md px-1.5 py-1 hover:bg-white/5 transition-colors">
          <input
            type="checkbox"
            bind:checked={formAutoExecute}
            class="w-3.5 h-3.5 rounded border-white/10 bg-slate-900 text-sky-500 focus:ring-sky-500/50 focus:ring-offset-0 cursor-pointer"
          />
          <span class="inline-flex items-center gap-1.5 text-[10px] text-slate-300">
            <span class="w-4 h-4 flex items-center justify-center rounded bg-sky-500/15 text-sky-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </span>
            Hit Enter (auto-execute)
          </span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer select-none rounded-md px-1.5 py-1 hover:bg-white/5 transition-colors">
          <input
            type="checkbox"
            bind:checked={formSendCtrlCBefore}
            class="w-3.5 h-3.5 rounded border-white/10 bg-slate-900 text-rose-500 focus:ring-rose-500/50 focus:ring-offset-0 cursor-pointer"
          />
          <span class="inline-flex items-center gap-1.5 text-[10px] text-slate-300">
            <span class="w-4 h-4 flex items-center justify-center rounded bg-rose-500/15 text-rose-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </span>
            Ctrl+C first
          </span>
        </label>
      </div>

      <div class="flex items-center justify-end gap-1.5 pt-0.5">
        <button
          type="button"
          onclick={closeForm}
          class="px-2 py-1 rounded-md text-[10px] font-semibold text-slate-400 hover:text-slate-200 hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={saveForm}
          class="px-2 py-1 rounded-md text-[10px] font-semibold text-white bg-sky-500 hover:bg-sky-400 shadow-sm shadow-sky-500/20 transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  {/if}

  {#if savedCommands.length === 0}
    <p class="text-[11px] text-slate-600 italic px-1 py-2">No saved commands yet.</p>
  {:else}
    <div class="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
      {#each savedCommands as cmd (cmd.id)}
        <div class="flex items-center gap-1 px-1 py-1 rounded-md hover:bg-white/5 group/cmd text-[11px]">
          {#if pendingDeleteId === cmd.id}
            <div class="flex-1 flex items-center justify-between gap-2 px-1">
              <span class="text-rose-300 text-[10px]">Delete this shortcut?</span>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  onclick={() => { pendingDeleteId = null; }}
                  class="px-1.5 py-0.5 rounded text-[10px] font-semibold text-slate-400 hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onclick={() => confirmDelete(cmd.id)}
                  class="px-1.5 py-0.5 rounded text-[10px] font-semibold text-white bg-rose-500 hover:bg-rose-400"
                >
                  Delete
                </button>
              </div>
            </div>
          {:else}
            <!-- Three action toggles (bottom-right so tooltips stay on-screen) -->
            <button
              type="button"
              aria-label={cmd.isOnConnect ? 'Disable auto-run on connect' : 'Enable auto-run on connect'}
              data-tooltip={cmd.isOnConnect ? 'Auto-run on connect (on)' : 'Auto-run on connect (off)'}
              data-tooltip-pos="bottom-right"
              onclick={() => toggleCommandOnConnect(connId, projectId, terminalId, cmd.id)}
              class="shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors {cmd.isOnConnect ? 'text-emerald-400 bg-emerald-500/20' : 'text-slate-600 hover:text-slate-400 hover:bg-white/5'}"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
            <button
              type="button"
              aria-label={cmd.autoExecute !== false ? 'Disable hit Enter' : 'Enable hit Enter'}
              data-tooltip={cmd.autoExecute !== false ? 'Hit Enter / auto-execute (on)' : 'Inject text only (Enter off)'}
              data-tooltip-pos="bottom-right"
              onclick={() => toggleCommandAutoExecute(connId, projectId, terminalId, cmd.id)}
              class="shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors {cmd.autoExecute !== false ? 'text-sky-400 bg-sky-500/20' : 'text-amber-400 bg-amber-500/15'}"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill={cmd.autoExecute !== false ? 'none' : 'currentColor'} stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">{#if cmd.autoExecute !== false}<polygon points="5 3 19 12 5 21 5 3"/>{:else}<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6"/><path d="M9 15h4"/>{/if}</svg>
            </button>
            <button
              type="button"
              aria-label={cmd.sendCtrlCBefore ? 'Disable Ctrl+C first' : 'Enable Ctrl+C first'}
              data-tooltip={cmd.sendCtrlCBefore ? 'Ctrl+C first (on)' : 'Ctrl+C first (off)'}
              data-tooltip-pos="bottom-right"
              onclick={() => toggleCommandCtrlCBefore(connId, projectId, terminalId, cmd.id)}
              class="shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors {cmd.sendCtrlCBefore ? 'text-rose-400 bg-rose-500/20' : 'text-slate-600 hover:text-slate-400 hover:bg-white/5'}"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>

            <button
              type="button"
              aria-label="Run {cmd.label}"
              data-tooltip="{cmd.sendCtrlCBefore ? '(Ctrl+C) ' : ''}{cmd.autoExecute !== false ? 'Execute: ' : 'Inject: '}{cmd.command}"
              data-tooltip-pos="bottom-right"
              onclick={() => onRun?.(cmd.command, cmd.autoExecute !== false, !!cmd.sendCtrlCBefore)}
              class="flex-1 min-w-0 text-left truncate text-slate-400 hover:text-white transition-colors px-1"
            >
              <span class="font-medium text-slate-300">{cmd.label}</span>
              <span class="text-slate-600 ml-1">→ {cmd.command}</span>
            </button>

            <button
              type="button"
              aria-label="Duplicate {cmd.label}"
              data-tooltip="Duplicate"
              data-tooltip-pos="bottom-left"
              onclick={() => duplicateSavedCommand(connId, projectId, terminalId, cmd.id)}
              class="shrink-0 p-0.5 text-slate-600 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors opacity-0 group-hover/cmd:opacity-100"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button
              type="button"
              aria-label="Edit {cmd.label}"
              data-tooltip="Edit"
              data-tooltip-pos="bottom-left"
              onclick={() => openEdit(cmd)}
              class="shrink-0 p-0.5 text-slate-600 hover:text-sky-400 rounded hover:bg-sky-500/20 transition-colors opacity-0 group-hover/cmd:opacity-100"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button
              type="button"
              aria-label="Remove {cmd.label}"
              data-tooltip="Remove"
              data-tooltip-pos="bottom-left"
              onclick={() => { pendingDeleteId = cmd.id; }}
              class="shrink-0 p-0.5 text-slate-600 hover:text-rose-400 rounded hover:bg-rose-500/20 transition-colors opacity-0 group-hover/cmd:opacity-100"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

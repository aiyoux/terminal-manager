<script lang="ts">
  import {
    getOwnVariables,
    getInheritedVariableEntries,
    getEffectiveVariableEntries,
    setVariable,
    removeVariable,
    renameVariableKey,
    type VariableOwnerRef,
    type VariableSourceEntry,
  } from '$lib/stores.svelte';

  let {
    scopeRef,
    title = 'Variables',
    onClose,
  }: {
    scopeRef: VariableOwnerRef;
    title: string;
    onClose: () => void;
  } = $props();

  let backdropDown = false;
  function onBackdropPointerDown(e: PointerEvent) {
    backdropDown = e.target === e.currentTarget;
  }
  function onBackdropClick(e: MouseEvent) {
    if (backdropDown && e.target === e.currentTarget) onClose();
    backdropDown = false;
  }

  let newKey = $state('');
  let newValue = $state('');
  let error = $state('');
  let notice = $state('');
  let renameFrom = $state('');
  let renameTo = $state('');
  let tick = $state(0);

  let editingKey = $state<string | null>(null);
  let editingValue = $state('');

  let own = $derived.by(() => {
    tick;
    return getOwnVariables(scopeRef);
  });
  let inherited = $derived.by(() => {
    tick;
    return getInheritedVariableEntries(scopeRef);
  });
  let effective = $derived.by(() => {
    tick;
    return scopeRef.kind === 'terminal'
      ? getEffectiveVariableEntries(scopeRef.terminalId)
      : ([] as VariableSourceEntry[]);
  });

  const isTerminalGroup = $derived(scopeRef.kind === 'terminalGroup');

  function refresh() {
    tick += 1;
  }

  function handleAdd() {
    error = '';
    notice = '';
    const r = setVariable(scopeRef, newKey.trim(), newValue);
    if (!r.ok) {
      error = r.error;
      return;
    }
    newKey = '';
    newValue = '';
    refresh();
  }

  function handleEdit(key: string, currentValue: string) {
    editingKey = key;
    editingValue = currentValue;
  }

  function handleEditSave() {
    if (!editingKey) return;
    error = '';
    notice = '';
    const r = setVariable(scopeRef, editingKey, editingValue);
    if (!r.ok) {
      error = r.error;
      return;
    }
    editingKey = null;
    editingValue = '';
    refresh();
  }

  function handleEditCancel() {
    editingKey = null;
    editingValue = '';
  }

  function handleDelete(key: string) {
    error = '';
    notice = '';
    removeVariable(scopeRef, key);
    refresh();
  }

  function handleRename() {
    error = '';
    notice = '';
    const r = renameVariableKey(scopeRef, renameFrom.trim(), renameTo.trim());
    if (!r.ok) {
      error = r.error;
      return;
    }
    if (r.referenceCount > 0) {
      notice = `Renamed key. ${r.referenceCount} command reference(s) still use \${${renameFrom.trim()}} — use Text Replace to update them.`;
    } else {
      notice = 'Renamed key.';
    }
    renameFrom = '';
    renameTo = '';
    refresh();
  }

  function sourceLabel(s: VariableSourceEntry['source']): string {
    if (s.kind === 'context') return 'context';
    return `${s.kind}: ${s.name}`;
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title} onpointerdown={onBackdropPointerDown} onclick={onBackdropClick}>
  <div class="w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
    <div class="flex items-center justify-between px-4 py-3 border-b border-slate-700">
      <div>
        <h2 class="text-sm font-semibold text-slate-100">{title}</h2>
        <p class="text-[10px] text-slate-500 mt-0.5">User variables + context (terminal.name, project.name, …)</p>
      </div>
      <button type="button" class="p-1 text-slate-400 hover:text-white rounded" onclick={onClose} aria-label="Close">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="overflow-y-auto p-4 space-y-4 text-xs">
      {#if error}
        <div class="rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-200 px-3 py-2">{error}</div>
      {/if}
      {#if notice}
        <div class="rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-100 px-3 py-2">{notice}</div>
      {/if}

      {#if isTerminalGroup}
        <p class="text-[11px] text-slate-400 leading-relaxed">
          These variables merge into each <strong class="text-slate-200">member terminal</strong> after connection/project vars
          (later groups override earlier). Effective values differ per member — select a terminal to preview context.
        </p>
      {/if}

      <section>
        <h3 class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Own variables</h3>
        <div class="space-y-1 mb-3">
          {#each Object.entries(own) as [key, value] (key)}
            <div class="flex items-center gap-2 rounded-md bg-slate-800/80 px-2 py-1.5">
              <code class="text-sky-300 font-mono shrink-0">{key}</code>
              <span class="text-slate-500">=</span>
              {#if editingKey === key}
                <input
                  bind:value={editingValue}
                  class="bg-slate-900 border border-sky-600 rounded px-2 py-0.5 text-slate-200 font-mono flex-1 min-w-0"
                  data-no-drag
                  onkeydown={(e) => { if (e.key === 'Enter') handleEditSave(); if (e.key === 'Escape') handleEditCancel(); }}
                />
                <button type="button" class="text-emerald-400 hover:text-emerald-300 shrink-0 text-[10px]" onclick={handleEditSave}>Save</button>
                <button type="button" class="text-slate-400 hover:text-slate-200 shrink-0 text-[10px]" onclick={handleEditCancel}>Cancel</button>
              {:else}
                <span class="text-slate-200 truncate flex-1 font-mono">{value}</span>
                <button type="button" class="text-sky-400 hover:text-sky-300 shrink-0 text-[10px]" onclick={() => handleEdit(key, value)}>Edit</button>
                <button type="button" class="text-rose-400 hover:text-rose-300 shrink-0 text-[10px]" onclick={() => handleDelete(key)}>Delete</button>
              {/if}
            </div>
          {:else}
            <p class="text-slate-600 italic">No own variables</p>
          {/each}
        </div>

        <div class="flex flex-wrap gap-2 items-end">
          <label class="flex flex-col gap-0.5">
            <span class="text-[9px] text-slate-500 uppercase">Key</span>
            <input bind:value={newKey} class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200 w-28 font-mono" placeholder="env" />
          </label>
          <label class="flex flex-col gap-0.5 flex-1 min-w-[8rem]">
            <span class="text-[9px] text-slate-500 uppercase">Value</span>
            <input bind:value={newValue} class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200 font-mono w-full" placeholder="prod" />
          </label>
          <button type="button" class="px-3 py-1.5 rounded-md bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 font-semibold" onclick={handleAdd}>Add</button>
        </div>
      </section>

      {#if !isTerminalGroup && scopeRef.kind !== 'connection'}
        <section>
          <h3 class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Inherited</h3>
          <div class="space-y-1">
            {#each inherited as entry (`${entry.source.kind}-${entry.key}-${entry.value}`)}
              <div class="flex items-center gap-2 rounded-md bg-slate-800/40 px-2 py-1 text-slate-400">
                <code class="text-slate-300 font-mono">{entry.key}</code>
                <span>=</span>
                <span class="font-mono truncate flex-1">{entry.value}</span>
                <span class="text-[9px] text-slate-600 shrink-0">{sourceLabel(entry.source)}</span>
              </div>
            {:else}
              <p class="text-slate-600 italic">None</p>
            {/each}
          </div>
        </section>
      {/if}

      {#if scopeRef.kind === 'terminal'}
        <section>
          <h3 class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Effective (incl. context)</h3>
          <div class="space-y-1 max-h-40 overflow-y-auto">
            {#each effective as entry (`eff-${entry.source.kind}-${entry.key}`)}
              <div class="flex items-center gap-2 rounded-md bg-slate-800/40 px-2 py-1 text-slate-400">
                <code class="text-violet-300 font-mono">{entry.key}</code>
                <span>=</span>
                <span class="font-mono truncate flex-1">{entry.value}</span>
                <span class="text-[9px] text-slate-600 shrink-0">{sourceLabel(entry.source)}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <section>
        <h3 class="text-[10px] uppercase tracking-widest text-slate-500 mb-2">Rename key</h3>
        <p class="text-[10px] text-slate-500 mb-2">Renames the map key only — does not rewrite commands. Use Text Replace for ${'{'}old{'}'} → ${'{'}new{'}'}.</p>
        <div class="flex flex-wrap gap-2 items-end">
          <label class="flex flex-col gap-0.5">
            <span class="text-[9px] text-slate-500 uppercase">From</span>
            <input bind:value={renameFrom} class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200 w-24 font-mono" />
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-[9px] text-slate-500 uppercase">To</span>
            <input bind:value={renameTo} class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-200 w-24 font-mono" />
          </label>
          <button type="button" class="px-3 py-1.5 rounded-md bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 font-semibold" onclick={handleRename}>Rename</button>
        </div>
      </section>
    </div>
  </div>
</div>

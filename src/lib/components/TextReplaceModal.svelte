<script lang="ts">
  import {
    previewCommandTextReplace,
    applyCommandTextReplace,
    type VariableOwnerRef,
    type TextReplacePreview,
  } from '$lib/stores.svelte';

  let {
    scopeRef,
    onClose,
  }: {
    scopeRef: VariableOwnerRef;
    onClose: () => void;
  } = $props();

  let find = $state('');
  let replace = $state('');
  let mode = $state<'literal' | 'toVariable'>('literal');
  let variableKey = $state('');
  let ensureVariable = $state(true);
  let replaceAll = $state(true);
  let error = $state('');
  let resultMsg = $state('');
  let preview = $state<TextReplacePreview | null>(null);

  const PREVIEW_CAP = 100;

  function runPreview() {
    error = '';
    resultMsg = '';
    preview = null;
    const r = previewCommandTextReplace({
      scopeRef,
      find,
      mode,
      replace: mode === 'literal' ? replace : undefined,
      replaceAll,
      variableKey: mode === 'toVariable' ? variableKey.trim() : undefined,
      ensureVariable: mode === 'toVariable' ? ensureVariable : false,
      requireInScope: true,
    });
    if (!r.ok) {
      error = r.error;
      return;
    }
    preview = r;
  }

  function runApply() {
    if (!preview) return;
    error = '';
    const r = applyCommandTextReplace(preview);
    resultMsg = `Applied ${r.applied} change(s)${r.skippedStale ? `, skipped ${r.skippedStale} stale` : ''}${r.ensured ? ', variable set' : ''}.`;
    preview = null;
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Replace in commands">
  <div class="w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
    <div class="flex items-center justify-between px-4 py-3 border-b border-slate-700">
      <h2 class="text-sm font-semibold text-slate-100">Replace in commands</h2>
      <button type="button" class="p-1 text-slate-400 hover:text-white rounded" onclick={onClose} aria-label="Close">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>

    <div class="overflow-y-auto p-4 space-y-3 text-xs">
      {#if error}
        <div class="rounded-md bg-rose-500/15 border border-rose-500/30 text-rose-200 px-3 py-2">{error}</div>
      {/if}
      {#if resultMsg}
        <div class="rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-100 px-3 py-2">{resultMsg}</div>
      {/if}

      <label class="flex flex-col gap-0.5">
        <span class="text-[9px] text-slate-500 uppercase">Find</span>
        <input bind:value={find} class="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono" placeholder="text to find" />
      </label>

      <div class="flex gap-3">
        <label class="flex items-center gap-1.5 text-slate-300">
          <input type="radio" bind:group={mode} value="literal" />
          Text → text
        </label>
        <label class="flex items-center gap-1.5 text-slate-300">
          <input type="radio" bind:group={mode} value="toVariable" />
          Text → variable
        </label>
      </div>

      {#if mode === 'literal'}
        <label class="flex flex-col gap-0.5">
          <span class="text-[9px] text-slate-500 uppercase">Replace with</span>
          <input bind:value={replace} class="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono" />
        </label>
      {:else}
        <label class="flex flex-col gap-0.5">
          <span class="text-[9px] text-slate-500 uppercase">Variable key</span>
          <input bind:value={variableKey} class="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono" placeholder="env" />
        </label>
        <label class="flex items-center gap-1.5 text-slate-300">
          <input type="checkbox" bind:checked={ensureVariable} />
          Set/update variable on this scope (value = find text)
        </label>
      {/if}

      <label class="flex items-center gap-1.5 text-slate-300">
        <input type="checkbox" bind:checked={replaceAll} />
        Replace all occurrences in each command
      </label>

      <div class="flex gap-2">
        <button type="button" class="px-3 py-1.5 rounded-md bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 font-semibold" onclick={runPreview}>Preview</button>
        <button
          type="button"
          class="px-3 py-1.5 rounded-md bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 font-semibold disabled:opacity-40"
          disabled={!preview}
          onclick={runApply}
        >Apply</button>
      </div>

      {#if preview}
        <div class="text-[11px] text-slate-400">
          {preview.totalMatchCount} occurrence(s) in {preview.matches.length} command(s)
          {#if preview.skipped.length}
            · {preview.skipped.length} skipped (out of scope)
          {/if}
        </div>
        <div class="space-y-2 max-h-48 overflow-y-auto">
          {#each preview.matches.slice(0, PREVIEW_CAP) as m (m.commandId)}
            <div class="rounded-md border border-slate-800 bg-slate-800/50 p-2">
              <div class="text-[10px] text-slate-500 mb-1">{m.terminalName} · {m.commandLabel}</div>
              <div class="font-mono text-rose-300/80 line-through truncate">{m.before}</div>
              <div class="font-mono text-emerald-300 truncate">{m.after}</div>
            </div>
          {/each}
          {#if preview.matches.length > PREVIEW_CAP}
            <p class="text-slate-500 italic">Showing first {PREVIEW_CAP} of {preview.matches.length}…</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

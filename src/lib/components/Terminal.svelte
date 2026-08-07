<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import '@xterm/xterm/css/xterm.css';
  import {
    closeConnection,
    sendInput,
    sendResize,
    subscribe,
    getBuffer,
    isConnected as checkConnected,
    connectionStatuses,
    reconnectConnection,
  } from '$lib/connectionManager.svelte';
  import { updateTerminalFontSize, resolveCommandForTerminal, type SavedCommand } from '$lib/stores.svelte';
  import CommandShortcutsPanel from './CommandShortcutsPanel.svelte';

  let { wsUrl, title = "Terminal", tmuxSession = '', workingDir = '', terminalId = '', fontSize = 14, connId = '', projectId = '', savedCommands = [], pinned = false, dense = false, onAddToGroup, onTogglePin, onResolveError }: {
    wsUrl: string;
    title?: string;
    tmuxSession?: string;
    workingDir?: string;
    terminalId?: string;
    fontSize?: number;
    connId?: string;
    projectId?: string;
    savedCommands?: SavedCommand[];
    pinned?: boolean;
    /** Grid layout: square corners, no outer shadow, borders that collapse with neighbors. */
    dense?: boolean;
    onAddToGroup?: () => void;
    onTogglePin?: () => void;
    /** Called when variable resolution fails (fail-closed; no send). */
    onResolveError?: (message: string) => void;
  } = $props();

  let settingsOpen = $state(false);
  let settingsBtnEl: HTMLButtonElement | null = $state(null);

  function toggleSettings(e: MouseEvent) {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
  }

  let pointerDownInside = false;

  function handleWindowPointerDown(e: PointerEvent) {
    if (!settingsOpen) return;
    const target = e.target as Node | null;
    if (!target) return;
    const popover = document.getElementById(`cmd-settings-${terminalId}`);
    pointerDownInside = !!(popover?.contains(target) || settingsBtnEl?.contains(target));
  }

  function handleWindowClick(e: MouseEvent) {
    if (!settingsOpen) return;
    const wasInside = pointerDownInside;
    pointerDownInside = false;
    if (wasInside) return;
    const target = e.target as Node | null;
    if (!target) return;
    const popover = document.getElementById(`cmd-settings-${terminalId}`);
    if (popover?.contains(target) || settingsBtnEl?.contains(target)) return;
    settingsOpen = false;
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && settingsOpen) {
      settingsOpen = false;
    }
  }

  let terminalContainer: HTMLElement;
  let term: any;
  let fitAddon: any;
  let resizeObserver: ResizeObserver;
  let unsubscribe: (() => void) | null = null;

  let connected = $derived(!!connectionStatuses[terminalId]);
  let statusInterval: ReturnType<typeof setInterval>;
  let lastCols = 0;
  let lastRows = 0;
  let lastContainerWidth = 0;
  let lastContainerHeight = 0;

  // DA response patterns — only filter during buffer replay, not live data
  const DA_FULL = /\x1b\[[\?>]?[\d;]*c/g;
  const DA_FRAG = /^[\?>]?[\d;]*c/;
  const daDecoder = new TextDecoder();

  function stripDA(data: Uint8Array | string): string | null {
    let text = typeof data === 'string' ? data : daDecoder.decode(data);
    text = text.replace(DA_FULL, '').replace(DA_FRAG, '');
    return text.length > 0 ? text : null;
  }

  /** Fit the terminal, only send resize if dimensions actually changed */
  function safeFit(force = false) {
    if (!term || !fitAddon || !terminalContainer || terminalContainer.offsetParent === null) return;
    // Skip if terminal slot is hidden (visibility: hidden)
    const slot = terminalContainer.closest('.terminal-slot');
    if (slot?.classList.contains('terminal-hidden')) return;
    const { clientWidth, clientHeight } = terminalContainer;
    if (clientWidth === 0 || clientHeight === 0) return;
    // Skip if container pixel size hasn't changed (avoids unnecessary fit/resize cycles)
    if (!force && clientWidth === lastContainerWidth && clientHeight === lastContainerHeight) return;
    lastContainerWidth = clientWidth;
    lastContainerHeight = clientHeight;
    fitAddon.fit();
    if (term.cols !== lastCols || term.rows !== lastRows) {
      lastCols = term.cols;
      lastRows = term.rows;
      sendResize(terminalId, term.cols, term.rows);
    }
  }

  async function initTerminal() {
    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    const { WebLinksAddon } = await import('@xterm/addon-web-links');

    term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      lineHeight: 1.2,
      theme: {
        background: '#0f172a', // Slate 900
        foreground: '#f1f5f9', // Slate 100
        cursor: '#38bdf8',     // Sky 400
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
        black: '#020617',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#f1f5f9',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, monospace',
      allowTransparency: true,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(terminalContainer);
    
    // Fit initially
    setTimeout(safeFit, 50);

    term.onData((data: string) => {
      sendInput(terminalId, data);
    });

    // Start connection first so subscribe can find it
    const { getOrCreateConnection } = await import('$lib/connectionManager.svelte');
    getOrCreateConnection(terminalId, wsUrl, tmuxSession, workingDir, term.cols, term.rows);

    // Replay buffered output (strip DA responses from historical data)
    const buffer = getBuffer(terminalId);
    if (buffer) {
      for (const chunk of buffer) {
        const cleaned = stripDA(chunk);
        if (cleaned) term.write(cleaned);
      }
    }

    // Subscribe to new data — write directly, DA filtering is handled by connectionManager
    unsubscribe = subscribe(terminalId, (data) => {
      term.write(data);
    });
  }

  onMount(() => {
    initTerminal();

    let resizeTimeout: ReturnType<typeof setTimeout>;
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(safeFit, 150);
    });
    resizeObserver.observe(terminalContainer);

    window.addEventListener('pointerdown', handleWindowPointerDown, true);
    window.addEventListener('click', handleWindowClick, true);
    window.addEventListener('keydown', handleWindowKeydown);
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
    if (term) term.dispose();
    if (resizeObserver) resizeObserver.disconnect();
    window.removeEventListener('pointerdown', handleWindowPointerDown, true);
    window.removeEventListener('click', handleWindowClick, true);
    window.removeEventListener('keydown', handleWindowKeydown);
  });

  function handleReconnect() {
    if (term) {
      // Reset terminal modes before reconnecting. The previous session (e.g. tmux)
      // may have enabled mouse tracking, bracketed paste, etc. Without resetting,
      // xterm.js continues generating mouse event escape sequences (\e[<...M) that
      // get sent as input to the new shell — which doesn't have tmux running yet —
      // causing "zsh: command not found" errors from the escape code fragments.
      term.write('\x1b[?1000l');  // Disable normal mouse tracking
      term.write('\x1b[?1002l');  // Disable button-event mouse tracking
      term.write('\x1b[?1003l');  // Disable any-event mouse tracking
      term.write('\x1b[?1006l');  // Disable SGR extended mouse mode
      term.write('\x1b[?2004l');  // Disable bracketed paste mode
    }
    safeFit();
    reconnectConnection(terminalId, wsUrl, tmuxSession, workingDir);
    setTimeout(() => {
      if (term) sendResize(terminalId, term.cols, term.rows);
    }, 200);
  }

  // React to font size changes
  $effect(() => {
    const currentSize = fontSize;
    if (term && term.options.fontSize !== currentSize) {
      term.options.fontSize = currentSize;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          safeFit(true);
        });
      });
    }
  });

  function handleFontSize(delta: number) {
    const newSize = Math.max(8, Math.min(32, fontSize + delta));
    if (newSize !== fontSize && connId && projectId) {
      updateTerminalFontSize(connId, projectId, terminalId, newSize);
    }
  }

  function handleClear() {
    if (term) {
      term.clear();
    }
  }

  function runCommand(command: string, autoExecute: boolean = true, sendCtrlCBefore: boolean = false) {
    // Resolve FIRST — no sendInput (including Ctrl+C) before ok
    const result = resolveCommandForTerminal(terminalId, command);
    if (!result.ok) {
      onResolveError?.(result.error);
      return;
    }
    const payload = autoExecute ? result.text + '\n' : result.text;
    if (sendCtrlCBefore) {
      sendInput(terminalId, '\x03'); // Ctrl+C
      setTimeout(() => {
        sendInput(terminalId, payload);
      }, 100);
    } else {
      sendInput(terminalId, payload);
    }
  }
</script>

<div
  class="terminal-chrome flex flex-col h-full w-full bg-[#0f172a] relative group
    {dense
      ? 'terminal-dense rounded-none border-0 border-r border-b border-slate-700 shadow-none'
      : 'rounded-xl border border-slate-700/50 shadow-2xl'}"
>
  <div class="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700 z-20 shrink-0 {dense ? 'rounded-none' : 'rounded-t-xl'}">
    <div class="flex items-center gap-2 min-w-0 mr-2">
      <div class={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-rose-500'}`}></div>
      <span class="text-xs font-medium text-slate-300 tracking-wide select-none truncate shrink-0 max-w-[10rem]">{title}</span>
      
      <!-- Quick Actions -->
      {#if connId && projectId && terminalId}
        <div class="relative flex items-center gap-1 ml-2 min-w-0">
          {#if savedCommands.length > 0}
            <div class="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5 min-w-0">
              {#each savedCommands as cmd}
                {@const autoExec = cmd.autoExecute !== false}
                {@const ctrlC = !!cmd.sendCtrlCBefore}
                {@const onConnect = !!cmd.isOnConnect}
                <button
                  type="button"
                  onclick={() => runCommand(cmd.command, autoExec, ctrlC)}
                  class="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-md text-[9px] font-semibold whitespace-nowrap border transition-all
                    {ctrlC
                      ? 'bg-rose-500/15 border-rose-500/35 text-rose-200 hover:bg-rose-500/25'
                      : !autoExec
                        ? 'bg-amber-500/15 border-amber-500/35 text-amber-200 hover:bg-amber-500/25'
                        : onConnect
                          ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200 hover:bg-emerald-500/25'
                          : 'bg-sky-500/15 border-sky-500/35 text-sky-200 hover:bg-sky-500/25'}"
                  data-tooltip="{ctrlC ? '(Ctrl+C) ' : ''}{autoExec ? 'Run: ' : 'Inject: '}{cmd.command}"
                  data-tooltip-pos="bottom-right"
                >
                  <span class="inline-flex items-center gap-0.5 shrink-0">
                    {#if onConnect}
                      <span class="text-emerald-400" title="Auto-run on connect">
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      </span>
                    {/if}
                    {#if autoExec}
                      <span class="text-sky-400" title="Hit Enter">
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      </span>
                    {:else}
                      <span class="text-amber-400" title="Inject only">
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6"/><path d="M9 15h4"/></svg>
                      </span>
                    {/if}
                    {#if ctrlC}
                      <span class="text-rose-400" title="Ctrl+C first">
                        <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                      </span>
                    {/if}
                  </span>
                  {cmd.label}
                </button>
              {/each}
            </div>
          {/if}

          <button
            bind:this={settingsBtnEl}
            type="button"
            onclick={toggleSettings}
            class="shrink-0 p-1 rounded transition-colors {settingsOpen ? 'text-sky-400 bg-sky-500/15' : 'text-slate-500 hover:text-slate-200 hover:bg-slate-700/80'}"
            aria-label="Command shortcut settings"
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            data-tooltip="Manage command shortcuts"
            data-tooltip-pos="bottom-right"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>

          {#if settingsOpen}
            <div
              id="cmd-settings-{terminalId}"
              role="dialog"
              tabindex="-1"
              aria-label="Command shortcut settings"
              class="absolute left-0 top-full mt-1.5 z-50 p-3 rounded-xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/50"
            >
              <CommandShortcutsPanel
                {connId}
                {projectId}
                {terminalId}
                {savedCommands}
                onRun={(command, autoExecute, sendCtrlCBefore) => {
                  runCommand(command, autoExecute, sendCtrlCBefore);
                }}
              />
            </div>
          {/if}
        </div>
      {/if}
    </div>
    
    <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-auto">
      {#if onAddToGroup}
        <button
          onclick={onAddToGroup}
          class="text-slate-400 hover:text-indigo-400 p-1 rounded hover:bg-slate-700 transition-colors"
          aria-label="Add to Group"
          data-tooltip="Add terminal to group"
          data-tooltip-pos="bottom-left"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
      {/if}

      {#if onTogglePin}
        <button
          onclick={onTogglePin}
          class="{pinned ? 'text-amber-400' : 'text-slate-400 hover:text-amber-400'} p-1 rounded hover:bg-slate-700 transition-colors"
          aria-label={pinned ? 'Unpin' : 'Pin'}
          data-tooltip={pinned ? 'Unpin terminal from top' : 'Pin terminal to top'}
          data-tooltip-pos="bottom-left"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
        </button>
      {/if}

      <div class="flex items-center bg-slate-700/50 rounded-md p-0.5 border border-slate-600/50 mr-1">
        <button
          onclick={() => handleFontSize(-1)}
          class="text-slate-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-slate-600 transition-colors text-[10px] font-bold"
          data-tooltip="Decrease font size"
          data-tooltip-pos="bottom-left"
        >-</button>
        <span class="text-[9px] font-mono text-slate-400 w-4 text-center">{fontSize}</span>
        <button
          onclick={() => handleFontSize(1)}
          class="text-slate-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-slate-600 transition-colors text-[10px] font-bold"
          data-tooltip="Increase font size"
          data-tooltip-pos="bottom-left"
        >+</button>
      </div>

      <button
        onclick={handleClear}
        class="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors"
        aria-label="Clear screen"
        data-tooltip="Clear screen output"
        data-tooltip-pos="bottom-left"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12H3"/><path d="m9 6-6 6 6 6"/></svg>
      </button>

      <button
        onclick={handleReconnect}
        class="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors"
        aria-label="Reconnect"
        data-tooltip="Reconnect terminal"
        data-tooltip-pos="bottom-left"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
    </div>
  </div>

  <!-- No padding around xterm — body fills chrome edge-to-edge (esp. dense grid). -->
  <div
    class="terminal-body flex-1 min-h-0 overflow-hidden bg-[#0f172a] relative p-0 {dense ? 'rounded-none' : 'rounded-b-xl'}"
    style="contain: layout paint; isolation: isolate;"
  >
    <div
      class="terminal-xterm-host absolute inset-0 overflow-hidden"
      bind:this={terminalContainer}
    ></div>
  </div>
</div>

<style>
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }

  /* Flush xterm into the host — no internal gutter from the library defaults. */
  .terminal-xterm-host :global(.xterm) {
    height: 100%;
    width: 100%;
    padding: 0 !important;
    margin: 0 !important;
  }
  .terminal-xterm-host :global(.xterm-viewport) {
    overflow-y: auto;
  }
  .terminal-xterm-host :global(.xterm-screen) {
    margin: 0 !important;
  }
</style>
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
  } from '$lib/connectionManager';
  import { updateTerminalFontSize, type SavedCommand } from '$lib/stores.svelte';

  let { wsUrl, title = "Terminal", tmuxSession = '', workingDir = '', terminalId = '', fontSize = 14, connId = '', projectId = '', savedCommands = [], pinned = false, onAddToGroup, onTogglePin }: {
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
    onAddToGroup?: () => void;
    onTogglePin?: () => void;
  } = $props();

  let terminalContainer: HTMLElement;
  let term: any;
  let fitAddon: any;
  let resizeObserver: ResizeObserver;
  let unsubscribe: (() => void) | null = null;

  let connected = $state(false);
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
    const { getOrCreateConnection } = await import('$lib/connectionManager');
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

    statusInterval = setInterval(() => {
      connected = checkConnected(terminalId);
    }, 1000);
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
    if (term) term.dispose();
    if (resizeObserver) resizeObserver.disconnect();
    if (statusInterval) clearInterval(statusInterval);
  });

  function handleReconnect() {
    import('$lib/connectionManager').then(m => {
      safeFit();
      m.getOrCreateConnection(terminalId, wsUrl, tmuxSession, workingDir, term.cols, term.rows);
      if (unsubscribe) unsubscribe();
      unsubscribe = m.subscribe(terminalId, (data) => {
        term.write(data);
      });
      setTimeout(() => {
        m.sendResize(terminalId, term.cols, term.rows);
      }, 200);
    });
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
    if (sendCtrlCBefore) {
      sendInput(terminalId, '\x03'); // Ctrl+C
      setTimeout(() => {
        sendInput(terminalId, autoExecute ? command + '\n' : command);
      }, 100);
    } else {
      sendInput(terminalId, autoExecute ? command + '\n' : command);
    }
  }
</script>

<div class="flex flex-col h-full w-full bg-slate-900 overflow-hidden rounded-xl border border-slate-700/50 shadow-2xl relative group">
  <div class="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700 z-10 shrink-0">
    <div class="flex items-center gap-2 overflow-hidden mr-2">
      <div class={`w-2.5 h-2.5 rounded-full shrink-0 ${connected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-rose-500'}`}></div>
      <span class="text-xs font-medium text-slate-300 tracking-wide select-none truncate shrink-0">{title}</span>
      
      <!-- Quick Actions -->
      {#if savedCommands.length > 0}
        <div class="flex items-center gap-1 ml-2 overflow-x-auto no-scrollbar py-0.5">
          {#each savedCommands as cmd}
            <button
              onclick={() => runCommand(cmd.command, cmd.autoExecute !== false, !!cmd.sendCtrlCBefore)}
              class="px-2 py-0.5 rounded bg-slate-700/50 hover:bg-slate-600 text-[9px] font-semibold text-slate-300 hover:text-white transition-all whitespace-nowrap border border-white/5 {cmd.autoExecute === false ? 'border-l-2 border-l-amber-500/50' : ''} {cmd.sendCtrlCBefore ? 'border-r-2 border-r-rose-500/50' : ''}"
              title="{cmd.sendCtrlCBefore ? '(Ctrl+C) ' : ''}{cmd.autoExecute === false ? 'Inject' : 'Run'}: {cmd.command}"
            >
              {cmd.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    
    <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-auto">
      {#if onAddToGroup}
        <button onclick={onAddToGroup} class="text-slate-400 hover:text-indigo-400 p-1 rounded hover:bg-slate-700 transition-colors" aria-label="Add to Group" title="Add to Group">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
        </button>
      {/if}

      {#if onTogglePin}
        <button onclick={onTogglePin} class="{pinned ? 'text-amber-400' : 'text-slate-400 hover:text-amber-400'} p-1 rounded hover:bg-slate-700 transition-colors" aria-label={pinned ? 'Unpin' : 'Pin'} title={pinned ? 'Unpin' : 'Pin'}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
        </button>
      {/if}

      <div class="flex items-center bg-slate-700/50 rounded-md p-0.5 border border-slate-600/50 mr-1">
        <button onclick={() => handleFontSize(-1)} class="text-slate-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-slate-600 transition-colors text-[10px] font-bold" title="Decrease font size">-</button>
        <span class="text-[9px] font-mono text-slate-400 w-4 text-center">{fontSize}</span>
        <button onclick={() => handleFontSize(1)} class="text-slate-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-slate-600 transition-colors text-[10px] font-bold" title="Increase font size">+</button>
      </div>

      <button onclick={handleClear} class="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors" aria-label="Clear screen" title="Clear screen">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12H3"/><path d="m9 6-6 6 6 6"/></svg>
      </button>

      <button onclick={handleReconnect} class="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors" aria-label="Reconnect" title="Reconnect">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
    </div>
  </div>

  <div class="flex-1 p-2 min-h-0 overflow-hidden bg-[#0f172a] relative" style="contain: layout paint; isolation: isolate;">
    <div
      class="h-full w-full"
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
</style>
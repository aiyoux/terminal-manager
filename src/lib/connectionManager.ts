// Centralized WebSocket connection manager
// WebSocket connections live here, independent of component lifecycle.
// Terminal.svelte attaches/detaches without affecting the connection.

import { getOnConnectCommands } from './stores.svelte';

type DataCallback = (data: Uint8Array | string) => void;

interface ManagedConnection {
  ws: WebSocket;
  wsUrl: string;
  tmuxSession: string;
  workingDir: string;
  buffer: (Uint8Array | string)[];   // Output buffer for replay on reattach
  callbacks: Set<DataCallback>;      // Active subscribers
  cols: number;
  rows: number;
  connected: boolean;
  hasInitializedSession: boolean;    // Track if tmux session was sent
  hasRunOnConnect: boolean;          // Track if on-connect command was sent
  textEncoder: TextEncoder;
  textDecoder: TextDecoder;
}

const connections = new Map<string, ManagedConnection>();

const CMD_INPUT = '0';
const CMD_RESIZE_TERMINAL = '1';

// Strip DA (Device Attributes) responses echoed back by the PTY during shell startup.
// Only needed briefly after connection — after that, skip the decode/encode overhead.
// Matches complete DA responses AND partial fragments (tail end from split messages).
const DA_RE = /\x1b\[[\?>]?[\d;]*c/g;
const DA_FRAGMENT_RE = /^[\?>]?[\d;]*c/; // Fragment at start: "1;2c" or "?1;2c" leftover from split ESC sequence
const DA_PARTIAL_END_RE = /\x1b\[[\?>]?[\d;]*$/; // Incomplete DA at end of message

function stripDAResponses(payload: Uint8Array, decoder: TextDecoder, encoder: TextEncoder, partialBuf: { value: string }): Uint8Array {
  let text = decoder.decode(payload);

  // If we had a partial DA sequence buffered from the previous message,
  // prepend it and try to match the combined string
  if (partialBuf.value) {
    const combined = partialBuf.value + text;
    partialBuf.value = '';
    text = combined.replace(DA_RE, '');
    // Also strip any remaining fragment at the start (e.g. "1;2c")
    text = text.replace(DA_FRAGMENT_RE, '');
  } else {
    // Strip fragment at the start (tail of a split DA response)
    text = text.replace(DA_FRAGMENT_RE, '');
  }

  // Strip complete DA responses
  text = text.replace(DA_RE, '');

  // Check if this message ends with an incomplete DA sequence — buffer it
  const partialMatch = text.match(DA_PARTIAL_END_RE);
  if (partialMatch) {
    partialBuf.value = partialMatch[0];
    text = text.slice(0, -partialMatch[0].length);
  }

  if (text.length === 0) return new Uint8Array(0);
  return encoder.encode(text);
}

/**
 * Get or create a WebSocket connection for a terminal.
 * If already connected, returns the existing connection.
 */
export function getOrCreateConnection(
  terminalId: string,
  wsUrl: string,
  tmuxSession: string = '',
  workingDir: string = '',
  cols: number = 80,
  rows: number = 24,
): ManagedConnection {
  const existing = connections.get(terminalId);
  if (existing && existing.ws.readyState <= WebSocket.OPEN) {
    return existing;
  }

  // Clean up any stale connection before creating a new one
  if (existing) {
    try { existing.ws.close(); } catch (_) {}
    connections.delete(terminalId);
  }

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const conn: ManagedConnection = {
    ws: null as any,
    wsUrl,
    tmuxSession,
    workingDir,
    buffer: [],
    callbacks: new Set(),
    cols,
    rows,
    connected: false,
    hasInitializedSession: false,
    hasRunOnConnect: false,
    textEncoder,
    textDecoder,
  };

  const ws = new WebSocket(wsUrl, ['tty']);
  ws.binaryType = 'arraybuffer';
  conn.ws = ws;

  // Only filter DA responses for the first few seconds after connect
  let filterDA = true;
  const daFilterTimer = setTimeout(() => { filterDA = false; }, 10000);
  const daPartialBuf = { value: '' };

  ws.onopen = () => {
    conn.connected = true;

    // ttyd init handshake
    const initMsg = JSON.stringify({ AuthToken: '', columns: conn.cols, rows: conn.rows });
    ws.send(textEncoder.encode(initMsg));

    // Run user-defined on-connect commands once per connection
    if (!conn.hasRunOnConnect) {
      conn.hasRunOnConnect = true;
      setTimeout(() => {
        const commands = getOnConnectCommands(terminalId);
        for (const cmd of commands) {
          sendInput(terminalId, cmd + '\n');
        }
      }, 500);
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;

    if (data instanceof ArrayBuffer) {
      const view = new Uint8Array(data);
      const cmd = view[0]; // ASCII char code
      const payload = view.subarray(1);

      switch (cmd) {
        case 48: { // '0' = terminal output
          const out = filterDA ? stripDAResponses(payload, textDecoder, textEncoder, daPartialBuf) : payload;
          if (out.length === 0) break;
          // Buffer for replay
          conn.buffer.push(out);
          // Cap buffer to prevent memory bloat
          if (conn.buffer.length > 1000) conn.buffer.shift();
          // Broadcast to all attached terminals
          for (const cb of conn.callbacks) cb(out);
          break;
        }
        case 49: // '1' = title (ignore)
          break;
        case 50: // '2' = prefs (ignore)
          break;
      }
    } else if (typeof data === 'string') {
      const cmd = data.charAt(0);
      const payload = data.slice(1);
      switch (cmd) {
        case '0': {
          const out = filterDA ? stripDAResponses(textEncoder.encode(payload), textDecoder, textEncoder, daPartialBuf) : payload;
          if (out.length === 0) break;
          conn.buffer.push(out);
          if (conn.buffer.length > 1000) conn.buffer.shift();
          for (const cb of conn.callbacks) cb(out);
          break;
        }
      }
    }
  };

  ws.onclose = () => {
    conn.connected = false;
    clearTimeout(daFilterTimer);
  };

  ws.onerror = () => {
    conn.connected = false;
  };

  connections.set(terminalId, conn);
  return conn;
}

/**
 * Send input keystrokes to a terminal's WebSocket.
 */
export function sendInput(terminalId: string, data: string) {
  const conn = connections.get(terminalId);
  if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;

  const encoded = conn.textEncoder.encode(data);
  const msg = new Uint8Array(encoded.length + 1);
  msg[0] = 48; // ASCII '0' = INPUT
  msg.set(encoded, 1);
  conn.ws.send(msg);
}

/**
 * Send a resize event to a terminal's WebSocket.
 */
export function sendResize(terminalId: string, cols: number, rows: number) {
  const conn = connections.get(terminalId);
  if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;

  conn.cols = cols;
  conn.rows = rows;
  conn.ws.send(conn.textEncoder.encode(CMD_RESIZE_TERMINAL + JSON.stringify({ columns: cols, rows: rows })));
}

/**
 * Subscribe to output data from a terminal.
 * Returns an unsubscribe function.
 */
export function subscribe(terminalId: string, callback: DataCallback): () => void {
  const conn = connections.get(terminalId);
  if (!conn) return () => {};

  conn.callbacks.add(callback);
  return () => { conn.callbacks.delete(callback); };
}

/**
 * Get the buffered output for replay when reattaching a terminal.
 * Strips any DA responses that may have been captured in the buffer.
 */
export function getBuffer(terminalId: string): (Uint8Array | string)[] {
  const conn = connections.get(terminalId);
  if (!conn) return [];
  return conn.buffer.map(chunk => {
    if (chunk instanceof Uint8Array) {
      const text = conn.textDecoder.decode(chunk);
      const cleaned = text.replace(DA_RE, '').replace(DA_FRAGMENT_RE, '');
      if (cleaned === text) return chunk; // no change, return original
      if (cleaned.length === 0) return null;
      return conn.textEncoder.encode(cleaned);
    }
    const cleaned = (chunk as string).replace(DA_RE, '').replace(DA_FRAGMENT_RE, '');
    if (cleaned.length === 0) return null;
    return cleaned;
  }).filter(Boolean) as (Uint8Array | string)[];
}

/**
 * Check if a terminal has an active connection.
 */
export function isConnected(terminalId: string): boolean {
  const conn = connections.get(terminalId);
  return !!conn && conn.ws.readyState === WebSocket.OPEN;
}

/**
 * Close and remove a terminal's connection.
 */
export function closeConnection(terminalId: string) {
  const conn = connections.get(terminalId);
  if (conn) {
    conn.callbacks.clear();
    if (conn.ws.readyState <= WebSocket.OPEN) {
      conn.ws.close();
    }
    connections.delete(terminalId);
  }
}

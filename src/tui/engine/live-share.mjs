/**
 * src/tui/engine/live-share.mjs — real-time cross-surface session mirroring.
 *
 * OWNER leg: hosts a local named-pipe (win32) / unix-socket server for the
 * session it owns and pushes frame-batched transcript deltas (items /
 * streaming tail / spinner) to attached viewers. Push-only: zero polling,
 * idle cost is one open listener.
 * VIEWER leg: connects to the owner's pipe and mirrors those deltas into the
 * local engine store, so streaming output appears live on every co-open
 * surface (desktop <-> terminal). Viewer submits travel over the same pipe
 * into the owner's normal submit queue (concurrent input from both sides is
 * serialized there); the durable pending spool remains the fallback when the
 * pipe is down. Ownership/promotion semantics are unchanged — the pipe is a
 * transport, never a second writer.
 */
import { createServer, connect } from 'node:net';
import { unlinkSync } from 'node:fs';

// Above this many patched rows per frame the delta degenerates to a full
// items push (bulk rewrites: compaction, clear, history restore).
const MAX_FRAME_PATCHES = 48;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
// Desync-recovery `sync` requests are throttled so a corrupt stream cannot
// make the owner serialize full transcripts every frame.
const SYNC_REQUEST_MIN_INTERVAL_MS = 500;

export function liveSharePipePath(sessionId, sessionFilePath) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mixdog-live-${sessionId}`
    : `${sessionFilePath}.live.sock`;
}

function frameLine(frame) {
  return `${JSON.stringify(frame)}\n`;
}

function attachLineReader(socket, onFrame, onOverflow) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_BYTES) {
      buffer = '';
      onOverflow?.();
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame = null;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame && typeof frame === 'object') onFrame(frame);
    }
  });
}

export function createLiveShare({
  ownerSessionId,
  viewerSessionId,
  socketPathFor,
  getPublishedState,
  listeners,
  onRemoteSubmit,
  onOwnerClosed,
  viewerApply,
}) {
  // ---- owner: pipe server + delta publisher ----
  let server = null;
  let serverId = '';
  let serverPath = '';
  const sockets = new Set();
  let lastItems = null;
  let lastTail = null;
  let lastSpinner = null;

  const broadcast = (frame) => {
    if (sockets.size === 0) return;
    const line = frameLine(frame);
    for (const socket of sockets) {
      try { socket.write(line); } catch { /* per-socket close handles it */ }
    }
  };

  const fullFrame = (st) => ({
    t: 'full',
    sessionId: serverId,
    items: Array.isArray(st.items) ? st.items : [],
    tail: st.streamingTail || null,
    spinner: st.spinner || null,
  });

  // Runs on every frame-batched publish. With no viewers it only re-baselines
  // references (pure pointer assignments) — effectively free.
  const onPublish = () => {
    const st = getPublishedState();
    if (!server || sockets.size === 0) {
      lastItems = st.items;
      lastTail = st.streamingTail;
      lastSpinner = st.spinner;
      return;
    }
    const frame = { t: 'delta' };
    let dirty = false;
    if (st.items !== lastItems) {
      const prev = Array.isArray(lastItems) ? lastItems : [];
      const next = Array.isArray(st.items) ? st.items : [];
      let structural = next.length < prev.length;
      const changed = [];
      if (!structural) {
        for (let i = 0; i < prev.length; i++) {
          if (next[i] === prev[i]) continue;
          if (!next[i]?.id || next[i].id !== prev[i]?.id) { structural = true; break; }
          changed.push(next[i]);
          if (changed.length > MAX_FRAME_PATCHES) { structural = true; break; }
        }
      }
      if (structural) {
        frame.items = next;
      } else {
        if (changed.length) frame.changed = changed;
        if (next.length > prev.length) frame.appended = next.slice(prev.length);
      }
      lastItems = st.items;
      dirty = true;
    }
    if (st.streamingTail !== lastTail) {
      const nextTail = st.streamingTail || null;
      const prevTail = lastTail || null;
      // Streaming text grows append-only frame to frame: ship just the new
      // suffix so long responses stay a few bytes per frame, not O(text).
      if (nextTail && prevTail && nextTail.id === prevTail.id
        && typeof nextTail.text === 'string' && typeof prevTail.text === 'string'
        && nextTail.text.length >= prevTail.text.length
        && nextTail.text.startsWith(prevTail.text)) {
        const meta = {};
        for (const [key, value] of Object.entries(nextTail)) {
          if (key === 'text') continue;
          if (!Object.is(prevTail[key], value)) meta[key] = value;
        }
        frame.tailAppend = {
          id: nextTail.id,
          base: prevTail.text.length,
          text: nextTail.text.slice(prevTail.text.length),
          ...(Object.keys(meta).length ? { meta } : {}),
        };
      } else {
        frame.tail = nextTail;
      }
      lastTail = st.streamingTail;
      dirty = true;
    }
    if (st.spinner !== lastSpinner) {
      frame.spinner = st.spinner || null;
      lastSpinner = st.spinner;
      dirty = true;
    }
    if (dirty) broadcast(frame);
  };
  listeners.add(onPublish);

  const stopServer = () => {
    if (!server) return;
    try { broadcast({ t: 'close' }); } catch { /* sockets closing anyway */ }
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    sockets.clear();
    const closing = server;
    server = null;
    try { closing.close(); } catch { /* already closed */ }
    if (process.platform !== 'win32' && serverPath) {
      try { unlinkSync(serverPath); } catch { /* never created / already gone */ }
    }
    serverId = '';
    serverPath = '';
  };

  const startServer = (id) => {
    const path = socketPathFor(id);
    const next = createServer((socket) => {
      socket.setNoDelay?.(true);
      sockets.add(socket);
      const cleanup = () => sockets.delete(socket);
      socket.on('close', cleanup);
      socket.on('error', () => {
        cleanup();
        try { socket.destroy(); } catch { /* already gone */ }
      });
      attachLineReader(socket, (frame) => {
        if (frame.t === 'submit' && typeof frame.text === 'string' && frame.text.trim()) {
          onRemoteSubmit(frame.text);
        } else if (frame.t === 'sync') {
          try { socket.write(frameLine(fullFrame(getPublishedState()))); } catch { /* close handles */ }
        }
      }, () => { try { socket.destroy(); } catch { /* already gone */ } });
      try {
        const st = getPublishedState();
        lastItems = st.items;
        lastTail = st.streamingTail;
        lastSpinner = st.spinner;
        socket.write(frameLine(fullFrame(st)));
      } catch {
        try { socket.destroy(); } catch { /* already gone */ }
      }
    });
    next.on('error', () => {
      // EADDRINUSE (another live owner) or a transient listen failure: give
      // up quietly; the next ensure() tick retries.
      if (server === next) { server = null; serverId = ''; serverPath = ''; }
      try { next.close(); } catch { /* already closed */ }
    });
    if (process.platform !== 'win32') {
      try { unlinkSync(path); } catch { /* no stale socket */ }
    }
    server = next;
    serverId = id;
    serverPath = path;
    try { next.listen(path); } catch {
      server = null;
      serverId = '';
      serverPath = '';
    }
  };

  // ---- viewer: pipe client mirroring owner deltas ----
  let client = null;
  let clientId = '';
  let clientUp = false;
  let lastSyncRequestAt = 0;

  const requestSync = (socket) => {
    const now = Date.now();
    if (now - lastSyncRequestAt < SYNC_REQUEST_MIN_INTERVAL_MS) return;
    lastSyncRequestAt = now;
    try { socket.write(frameLine({ t: 'sync' })); } catch { /* close handles */ }
  };

  const upsertItem = (item) => {
    if (!item || item.id == null) return;
    const items = viewerApply.getState().items;
    const exists = Array.isArray(items) && items.some((it) => it?.id === item.id);
    if (exists) viewerApply.patchItem(item.id, item);
    else viewerApply.appendItems([item]);
  };

  const applyViewerFrame = (frame, socket) => {
    if (frame.t === 'full') {
      viewerApply.replaceItems(Array.isArray(frame.items) ? frame.items : []);
      if (frame.tail) viewerApply.updateStreamingTail(frame.tail.id, frame.tail);
      viewerApply.set({ spinner: frame.spinner || null });
      return;
    }
    if (frame.t !== 'delta') return;
    if (Array.isArray(frame.items)) {
      viewerApply.replaceItems(frame.items, { preserveStreamingTail: true });
    } else {
      for (const item of frame.changed || []) upsertItem(item);
      for (const item of frame.appended || []) upsertItem(item);
    }
    if (frame.tailAppend) {
      const current = viewerApply.getState().streamingTail;
      const base = Number(frame.tailAppend.base) || 0;
      if (current && current.id === frame.tailAppend.id
        && typeof current.text === 'string' && current.text.length === base) {
        viewerApply.updateStreamingTail(frame.tailAppend.id, {
          ...(frame.tailAppend.meta || {}),
          text: current.text + String(frame.tailAppend.text || ''),
        });
      } else {
        // Suffix base mismatch — this mirror lost a frame; resync fully.
        requestSync(socket);
      }
    } else if ('tail' in frame) {
      if (frame.tail) viewerApply.updateStreamingTail(frame.tail.id, frame.tail);
      else viewerApply.clearStreamingTail();
    }
    if ('spinner' in frame) viewerApply.set({ spinner: frame.spinner || null });
  };

  const stopClient = () => {
    const closing = client;
    client = null;
    clientId = '';
    clientUp = false;
    if (closing) {
      try { closing.destroy(); } catch { /* already gone */ }
    }
  };

  const startClient = (id) => {
    let socket;
    try { socket = connect(socketPathFor(id)); } catch { return; }
    client = socket;
    clientId = id;
    clientUp = false;
    socket.setNoDelay?.(true);
    socket.on('connect', () => { if (client === socket) clientUp = true; });
    const down = (ownerClosed) => {
      const wasUp = clientUp && client === socket;
      if (client === socket) { client = null; clientId = ''; clientUp = false; }
      try { socket.destroy(); } catch { /* already gone */ }
      // A live link that dropped means the owner ended or crashed: nudge the
      // promotion path instead of waiting for the next store-mtime change.
      if (wasUp) onOwnerClosed?.(id, ownerClosed);
    };
    socket.on('error', () => down(false));
    socket.on('close', () => down(false));
    attachLineReader(socket, (frame) => {
      if (client !== socket) return;
      if (frame.t === 'close') { down(true); return; }
      if (viewerSessionId() !== id) return;
      try { applyViewerFrame(frame, socket); } catch { requestSync(socket); }
    }, () => down(false));
  };

  return {
    // Reconciles both legs against the current session role; called from the
    // engine share tick (also serves as the reconnect/retry cadence).
    ensure() {
      const ownerId = String(ownerSessionId() || '');
      const attachId = ownerId ? '' : String(viewerSessionId() || '');
      if (serverId && serverId !== ownerId) stopServer();
      if (ownerId && !server) startServer(ownerId);
      if (clientId && clientId !== attachId) stopClient();
      if (attachId && !client) startClient(attachId);
    },
    viewerConnected: () => clientUp,
    sendSubmit(text) {
      if (!clientUp || !client) return false;
      try {
        client.write(frameLine({ t: 'submit', text: String(text) }));
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      listeners.delete(onPublish);
      stopServer();
      stopClient();
    },
  };
}

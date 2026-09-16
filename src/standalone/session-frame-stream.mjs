// Session snapshots are latest-wins under backpressure; terminal byte streams
// concatenate instead. Keep socket ownership and bounded backlog policy here.
const TERMINAL_BACKLOG_MAX_CHARS = 256 * 1024;

function terminalDataFrame(frame) {
  return frame?.type === 'desktop-event' &&
    frame.message?.kind === 'desktop-event' &&
    frame.message?.name === 'terminal-data' &&
    typeof frame.message?.value?.data === 'string'
    ? frame
    : null;
}

function mergePendingFrame(existing, frame, json) {
  const previous = existing ? terminalDataFrame(existing.frame) : null;
  const next = terminalDataFrame(frame);
  if (!previous || !next) return { frame, json };
  const joined = `${previous.message.value.data}${next.message.value.data}`;
  const data =
    joined.length > TERMINAL_BACKLOG_MAX_CHARS ? joined.slice(joined.length - TERMINAL_BACKLOG_MAX_CHARS) : joined;
  const merged = {
    ...next,
    message: { ...next.message, value: { ...next.message.value, data } },
  };
  return { frame: merged, json: JSON.stringify(merged) };
}

function pendingEntry(frame, json, queuedAt) {
  return { frame, json, bytes: Buffer.byteLength(json) + 8, queuedAt };
}

function resyncEntry(frame) {
  if (frame?.type !== 'session-state' || !frame.sessionId) return null;
  const marker = {
    type: 'session-state',
    key: frame.key,
    sessionId: frame.sessionId,
    revision: -1,
    baseRevision: -2,
    patch: { set: {}, remove: [], itemsAppend: null },
    resyncRequired: true,
  };
  return pendingEntry(marker, JSON.stringify(marker));
}

export function createSessionFrameStream({ clients, maxPendingBytes, nowMs, onAttached, onClosed, onDiagnostic }) {
  const cleanups = new WeakMap();
  let diagnosticWindowAt = 0;
  let diagnosticCount = 0;
  let diagnosticSuppressed = 0;

  function traceFrame(client, frame, stage, { bytes, queuedAt } = {}, force = false) {
    if (typeof onDiagnostic !== 'function') return;
    const message =
      frame?.type === 'desktop-event' && frame.message?.kind === 'session-state'
        ? frame.message
        : frame?.type === 'session-state'
          ? frame
          : null;
    if (!message || typeof message.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(message.sessionId)) return;
    const traceId =
      typeof message.readTraceId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(message.readTraceId)
        ? message.readTraceId
        : undefined;
    if (!traceId && !force) return;
    const atMs = nowMs();
    if (atMs - diagnosticWindowAt >= 10_000) {
      diagnosticWindowAt = atMs;
      diagnosticCount = 0;
    }
    if (diagnosticCount >= 40) {
      diagnosticSuppressed += 1;
      return;
    }
    diagnosticCount += 1;
    try {
      onDiagnostic({
        stage,
        sessionId: message.sessionId,
        ...(traceId ? { traceId } : {}),
        atMs,
        ...(bytes !== undefined ? { bytes } : {}),
        ...(queuedAt !== undefined ? { queuedMs: Math.max(0, atMs - queuedAt) } : {}),
        pendingBytes: client.pendingBytes || 0,
        maxPendingBytes,
        ...(diagnosticSuppressed ? { suppressed: diagnosticSuppressed } : {}),
      });
      diagnosticSuppressed = 0;
    } catch {
      /* A diagnostic failure cannot lose a frame or change backpressure. */
    }
  }

  function retireStream(res) {
    if (!res) return;
    cleanups.get(res)?.();
    try {
      res.end();
    } catch {}
  }

  function flushPending(client) {
    while (client.sse && !client.paused && client.pending.size > 0) {
      const [key, entry] = client.pending.entries().next().value;
      client.pending.delete(key);
      client.pendingBytes = Math.max(0, client.pendingBytes - (entry.bytes || 0));
      try {
        if (client.sse.write(`data: ${entry.json}\n\n`) === false) client.paused = true;
        traceFrame(client, entry.frame, 'stream-write', entry);
      } catch {
        traceFrame(client, entry.frame, 'stream-write-failed', entry, true);
        retireStream(client.sse);
        client.pending.set(key, entry);
        client.pendingBytes += entry.bytes || 0;
        return;
      }
    }
  }

  function setPending(client, key, entry) {
    const previous = client.pending.get(key);
    if (previous) traceFrame(client, previous.frame, 'stream-replaced', previous);
    if (previous) client.pendingBytes = Math.max(0, client.pendingBytes - (previous.bytes || 0));
    client.pending.delete(key);
    client.pending.set(key, entry);
    client.pendingBytes += entry.bytes || 0;
    traceFrame(client, entry.frame, 'stream-queued', entry);
    while (client.pendingBytes > maxPendingBytes && client.pending.size > 0) {
      const [oldestKey, oldest] = client.pending.entries().next().value;
      const marker = resyncEntry(oldest.frame);
      if (marker && marker.bytes < oldest.bytes) {
        traceFrame(client, oldest.frame, 'stream-resync-marker', oldest, true);
        marker.queuedAt = oldest.queuedAt;
        client.pending.set(oldestKey, marker);
        client.pendingBytes += marker.bytes - oldest.bytes;
        continue;
      }
      traceFrame(client, oldest.frame, 'stream-dropped', oldest, true);
      client.pending.delete(oldestKey);
      client.pendingBytes = Math.max(0, client.pendingBytes - (oldest.bytes || 0));
    }
  }

  function writeFrame(client, frame, json) {
    const key = frame.key || `${frame.type}:${frame.sessionId || frame.desktopId || ''}`;
    if (!client.sse || client.paused) {
      const merged = mergePendingFrame(client.pending.get(key), frame, json);
      setPending(client, key, pendingEntry(merged.frame, merged.json, nowMs()));
      return;
    }
    try {
      if (client.sse.write(`data: ${json}\n\n`) === false) client.paused = true;
      traceFrame(client, frame, 'stream-write');
    } catch {
      traceFrame(client, frame, 'stream-write-failed', {}, true);
      retireStream(client.sse);
      const merged = mergePendingFrame(client.pending.get(key), frame, json);
      setPending(client, key, pendingEntry(merged.frame, merged.json, nowMs()));
    }
  }

  function broadcast(frame, targetTokens = null) {
    const json = JSON.stringify(frame);
    if (targetTokens) {
      for (const token of targetTokens) {
        const client = clients.get(String(token || ''));
        if (client) writeFrame(client, frame, json);
      }
      return;
    }
    for (const client of clients.values()) writeFrame(client, frame, json);
  }

  function attachSse(token, res) {
    const client = clients.get(token);
    if (!client) return false;
    try {
      res.socket?.setNoDelay(true);
    } catch {
      /* transport default stands */
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const paused = res.write(': attached\n\n') === false;
    const previous = client.sse;
    client.sse = res;
    client.paused = paused;
    client.lastSeen = nowMs();
    // Replacement transfers ownership before closing the old stream, so its
    // close/error callbacks cannot detach the new response.
    if (previous !== res) retireStream(previous);
    onAttached(token);

    let keepAlive = null;
    let cleaned = false;
    const onDrain = () => {
      if (client.sse !== res) return;
      client.paused = false;
      flushPending(client);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepAlive);
      cleanups.delete(res);
      res.off('drain', onDrain);
      if (client.sse === res) {
        client.sse = null;
        client.paused = false;
      }
      onClosed();
    };
    cleanups.set(res, cleanup);
    res.on('drain', onDrain);
    res.on('close', cleanup);
    res.on('error', cleanup);
    keepAlive = setInterval(() => {
      if (client.sse !== res || client.paused) return;
      try {
        if (res.write(': ka\n\n') === false) client.paused = true;
      } catch {
        retireStream(res);
      }
    }, 15_000);
    keepAlive.unref?.();
    flushPending(client);
    return true;
  }

  return { broadcast, attachSse };
}

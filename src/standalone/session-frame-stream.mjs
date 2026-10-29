// Session snapshots are latest-wins under backpressure; a session patch chains
// onto the queued frame it builds on, and terminal byte streams concatenate.
// Keep socket ownership and bounded backlog policy here.
const TERMINAL_BACKLOG_MAX_CHARS = 256 * 1024;
const KEEPALIVE_MS = 15_000;

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
  const sse = `data: ${json}\n\n`;
  return { frame, sse, bytes: Buffer.byteLength(sse), queuedAt };
}

function isResyncMarker(frame) {
  return frame?.resyncRequired === true || frame?.message?.resyncRequired === true;
}

// A patch builds on the frame queued before it for the same key. Replacing
// that frame hands the receiver a lane it cannot decode, and the resync it
// asks for re-sends the full snapshot into the same backlog.
function isPatchFrame(frame) {
  if (isResyncMarker(frame)) return false;
  if (frame?.type === 'session-state') return Boolean(frame.patch) && Number.isSafeInteger(frame.baseRevision);
  const wire = frame?.type === 'desktop-event' && frame.message?.kind === 'session-state' ? frame.message.wire : null;
  return Boolean(wire?.__itemsPatch);
}

function readTraceIdOf(frame) {
  return frame?.readTraceId ?? frame?.message?.readTraceId;
}

function resyncEntry(frame) {
  if (frame?.type === 'desktop-event' && frame.message?.kind === 'session-state' && frame.message.sessionId) {
    // The desktop decoder cannot apply a patch against base -2, so it resets
    // and asks its service for a fresh full snapshot of this session.
    const marker = {
      type: 'desktop-event',
      key: frame.key,
      desktopId: frame.desktopId,
      message: {
        kind: 'session-state',
        sessionId: frame.message.sessionId,
        resyncRequired: true,
        wire: { __itemsPatch: { base: -2, revision: -1 } },
      },
    };
    return pendingEntry(marker, JSON.stringify(marker));
  }
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
    let message = null;
    if (frame?.type === 'desktop-event' && frame.message?.kind === 'session-state') message = frame.message;
    else if (frame?.type === 'session-state') message = frame;
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

  function pause(client) {
    if (!client.paused) client.pausedAt = nowMs();
    client.paused = true;
  }

  // A stream paused across a keepalive period: bytes still buffered mean the
  // consumer stopped reading; none buffered means a drain that never fired.
  function reportStall(client, res) {
    if (typeof onDiagnostic !== 'function') return;
    const atMs = nowMs();
    if (atMs - client.pausedAt < KEEPALIVE_MS) return;
    try {
      onDiagnostic({
        stage: 'stream-stalled',
        atMs,
        pausedMs: atMs - client.pausedAt,
        bufferedBytes: res.writableLength,
        needDrain: res.writableNeedDrain,
        pendingBytes: client.pendingBytes || 0,
        maxPendingBytes,
      });
    } catch {
      /* A diagnostic failure cannot change backpressure. */
    }
  }

  function flushPending(client) {
    while (client.sse && !client.paused && client.pending.size > 0) {
      const [key, entry] = client.pending.entries().next().value;
      client.pending.delete(key);
      client.pendingBytes = Math.max(0, client.pendingBytes - (entry.bytes || 0));
      try {
        if (client.sse.write(entry.sse) === false) pause(client);
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
    if (previous) {
      traceFrame(client, previous.frame, 'stream-replaced', previous);
      client.pendingBytes = Math.max(0, client.pendingBytes - (previous.bytes || 0));
    }
    client.pending.delete(key);
    client.pending.set(key, entry);
    client.pendingBytes += entry.bytes || 0;
    traceFrame(client, entry.frame, 'stream-queued', entry);
    boundPending(client, key);
  }

  function boundPending(client, key) {
    // The cap bounds accumulated backlog: older entries collapse to resync
    // markers or drop, oldest first. The newest frame is always admitted, so a
    // snapshot larger than the cap still reaches a client with no backlog, and
    // markers are kept so a receiver always learns what it missed.
    for (const [oldestKey, oldest] of client.pending) {
      if (client.pendingBytes <= maxPendingBytes) break;
      // Only a single newest frame is exempt: a patch chain is backlog too.
      if ((oldestKey === key && !oldest.chained) || isResyncMarker(oldest.frame)) continue;
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

  function queueFrame(client, key, frame, json) {
    const existing = client.pending.get(key);
    if (existing && isPatchFrame(frame)) {
      // A queued marker already makes the receiver fetch a fresh full
      // snapshot, which supersedes every patch issued before it.
      if (isResyncMarker(existing.frame)) return;
      const next = pendingEntry(frame, json, nowMs());
      // Map.set on a present key keeps its place: the chain leaves with its base.
      client.pending.set(key, {
        frame: readTraceIdOf(existing.frame) ? existing.frame : frame,
        sse: existing.sse + next.sse,
        bytes: existing.bytes + next.bytes,
        queuedAt: existing.queuedAt,
        chained: true,
      });
      client.pendingBytes += next.bytes;
      traceFrame(client, frame, 'stream-queued', next);
      boundPending(client, key);
      return;
    }
    const merged = mergePendingFrame(existing, frame, json);
    setPending(client, key, pendingEntry(merged.frame, merged.json, nowMs()));
  }

  function writeFrame(client, frame, json) {
    const key = frame.key || `${frame.type}:${frame.sessionId || frame.desktopId || ''}`;
    if (!client.sse || client.paused) {
      queueFrame(client, key, frame, json);
      return;
    }
    try {
      if (client.sse.write(`data: ${json}\n\n`) === false) pause(client);
      traceFrame(client, frame, 'stream-write');
    } catch {
      traceFrame(client, frame, 'stream-write-failed', {}, true);
      retireStream(client.sse);
      queueFrame(client, key, frame, json);
    }
  }

  function broadcast(frame, targetTokens = null) {
    // Serialized once, and only when an SSE client is a target: frames meant
    // for in-process subscribers alone never pay for JSON.stringify.
    let json = null;
    const deliver = (client) => {
      json ??= JSON.stringify(frame);
      writeFrame(client, frame, json);
    };
    if (targetTokens) {
      for (const token of targetTokens) {
        const client = clients.get(String(token || ''));
        if (client) deliver(client);
      }
      return;
    }
    for (const client of clients.values()) deliver(client);
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
    client.paused = false;
    if (paused) pause(client);
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
      if (client.sse !== res) return;
      if (client.paused) {
        reportStall(client, res);
        return;
      }
      try {
        if (res.write(': ka\n\n') === false) pause(client);
      } catch {
        retireStream(res);
      }
    }, KEEPALIVE_MS);
    keepAlive.unref?.();
    flushPending(client);
    return true;
  }

  return { broadcast, attachSse };
}

/**
 * src/tui/session/live-share/owner.mjs - owner leg: named-pipe / unix-socket
 * server bound to ONE session id, pushing frame-batched deltas to attached
 * viewers and relaying their submit/abort frames into the owner queue.
 */
import { createServer } from 'node:net';
import { unlinkSync } from 'node:fs';
import { attachLineReader, destroyQuietly, frameLine } from './wire.mjs';
import { EMPTY_BASELINE, baselineOf, deltaFrame, fullFrame } from './delta.mjs';
import { createRetryTimer } from './retry.mjs';

function isSubmitFrame(frame) {
  return (
    frame.t === 'submit' &&
    ((typeof frame.text === 'string' && frame.text.trim()) ||
      typeof frame.prompt === 'string' ||
      Array.isArray(frame.prompt))
  );
}

function unlinkQuietly(path) {
  if (process.platform === 'win32' || !path) return;
  try {
    unlinkSync(path);
  } catch {
    /* never created / already gone */
  }
}

export function createOwnerLeg({
  ownerSessionId,
  socketPathFor,
  getPublishedState,
  onRemoteSubmit,
  onRemoteAbort,
  isDisposed,
  retryMinMs,
  retryMaxMs,
}) {
  let server = null;
  let serverId = '';
  let serverPath = '';
  const sockets = new Set();
  let baseline = EMPTY_BASELINE;
  const retry = createRetryTimer({
    minMs: retryMinMs,
    maxMs: retryMaxMs,
    shouldStart: (id) => !isDisposed() && !server && String(ownerSessionId() || '') === id,
    start: (id) => startServer(id),
  });

  const broadcast = (frame) => {
    if (sockets.size === 0) return;
    const line = frameLine(frame);
    for (const socket of sockets) {
      try {
        socket.write(line);
      } catch {
        /* per-socket close handles it */
      }
    }
  };

  // This pipe is bound to ONE session id (serverId). When the surface changes
  // session identity — /new, /clear, a resume of another session, a context
  // switch — the published store frames stop describing the session this pipe
  // represents. Pushing them anyway handed a co-open viewer an empty (or
  // foreign) transcript until the close/promote path restored it, which is the
  // flash seen in the desktop app when the terminal ran /new. Frames are
  // DROPPED without re-baselining, so a pipe that keeps its id (/clear) still
  // ships the post-reset delta once the reset settles; a pipe whose id changed
  // is torn down by the next ensure().
  const frameStale = () => Boolean(serverId) && String(ownerSessionId() || '') !== serverId;

  // Runs on every frame-batched publish. With no viewers it only re-baselines.
  const onPublish = () => {
    const st = getPublishedState();
    if (!server || sockets.size === 0) {
      baseline = baselineOf(st, '');
      return;
    }
    if (frameStale()) return;
    const next = deltaFrame(baseline, st);
    baseline = next.baseline;
    if (next.frame) broadcast(next.frame);
  };

  const acceptSubmit = (socket, frame) => {
    // Optional submission metadata (additive, old viewers omit it): the
    // originating surface's submission id must survive the pipe so its
    // optimistic user row releases when the SAME id settles in the
    // owner's transcript (user: 방금 친 메세지가 2개 남는다).
    const id = typeof frame.id === 'string' && frame.id.trim() ? frame.id : undefined;
    const submittedAt = Number(frame.submittedAt);
    const prompt = frame.prompt ?? frame.text;
    const delivered =
      onRemoteSubmit(prompt, {
        ...(frame.options && typeof frame.options === 'object' ? frame.options : {}),
        ...(id ? { id } : {}),
        ...(Number.isFinite(submittedAt) && submittedAt > 0 ? { submittedAt: Math.round(submittedAt) } : {}),
      }) !== false;
    // Acknowledge the verdict (additive: viewers without ack tokens are
    // unaffected). A refusal travels back as ok:false so the sender
    // re-delivers instead of assuming the prompt landed.
    const ackId = typeof frame.ack === 'string' && frame.ack.trim() ? frame.ack : '';
    if (!ackId) return;
    try {
      socket.write(frameLine({ t: 'submit-ack', ack: ackId, ok: delivered }));
    } catch {
      /* close handles it; the sender's ack timeout re-delivers */
    }
  };

  const handleViewerFrame = (socket, frame) => {
    if (isSubmitFrame(frame)) {
      acceptSubmit(socket, frame);
    } else if (frame.t === 'abort') {
      // Viewer stop button: interrupt the owner's active turn here — the
      // viewer process has no turn of its own to cancel.
      onRemoteAbort?.();
    } else if (frame.t === 'sync') {
      if (frameStale()) return;
      try {
        socket.write(frameLine(fullFrame(serverId, getPublishedState())));
      } catch {
        /* close handles */
      }
    }
  };

  const attachViewer = (socket) => {
    socket.setNoDelay?.(true);
    sockets.add(socket);
    const cleanup = () => sockets.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', () => {
      cleanup();
      destroyQuietly(socket);
    });
    attachLineReader(
      socket,
      (frame) => handleViewerFrame(socket, frame),
      () => destroyQuietly(socket)
    );
    try {
      // Connected mid-reset: this state belongs to another session, and a
      // baseline taken from it would desync every later delta. Drop the
      // socket — the viewer's own retry finds the rebound pipe (or promotes).
      if (frameStale()) {
        destroyQuietly(socket);
        return;
      }
      const st = getPublishedState();
      baseline = baselineOf(st);
      socket.write(frameLine(fullFrame(serverId, st)));
    } catch {
      destroyQuietly(socket);
    }
  };

  const stopServer = () => {
    retry.clear();
    retry.reset();
    if (!server) {
      serverId = '';
      serverPath = '';
      return;
    }
    try {
      broadcast({ t: 'close' });
    } catch {
      /* sockets closing anyway */
    }
    for (const socket of sockets) destroyQuietly(socket);
    sockets.clear();
    const closing = server;
    server = null;
    try {
      closing.close();
    } catch {
      /* already closed */
    }
    unlinkQuietly(serverPath);
    serverId = '';
    serverPath = '';
  };

  // EADDRINUSE (another live owner) or a transient listen failure: retry
  // with a short bounded backoff while this surface still owns the id.
  const retryAfterListenFailure = (id) => {
    server = null;
    serverId = '';
    serverPath = '';
    retry.schedule(id);
  };

  const startServer = (id) => {
    if (isDisposed() || server || !id) return;
    retry.clear();
    const path = socketPathFor(id);
    const next = createServer(attachViewer);
    next.on('error', () => {
      if (server === next) retryAfterListenFailure(id);
      try {
        next.close();
      } catch {
        /* already closed */
      }
    });
    next.on('listening', () => {
      if (server !== next) return;
      retry.clear();
      retry.reset();
    });
    unlinkQuietly(path);
    server = next;
    serverId = id;
    serverPath = path;
    try {
      next.listen(path);
    } catch {
      retryAfterListenFailure(id);
    }
  };

  // Reconcile against the session this surface currently owns ('' = none).
  const ensure = (ownerId) => {
    if (retry.id() && retry.id() !== ownerId) retry.clear();
    if (!ownerId && retry.pending()) retry.clear();
    if (serverId && serverId !== ownerId) stopServer();
    if (ownerId && !server && !retry.pending()) startServer(ownerId);
  };

  return { ensure, stop: stopServer, onPublish };
}

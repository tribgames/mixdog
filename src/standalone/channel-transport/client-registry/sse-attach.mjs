// client-registry/sse-attach.mjs
// Binding a registered client's notify stream: the SSE response headers, the
// prelude that flushes them, frames buffered while the client had no stream,
// the keepalive comment, and stream-loss bookkeeping.
const KEEPALIVE_MS = 15_000;

export function attachClientStream({ client, res, stickyFrame, onClosed }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Prelude comment flushes headers so the client's SSE reader resolves.
  res.write(': attached\n\n');
  client.sse = res;
  client.lastSeen = Date.now();
  // Flush any targeted frames buffered while this client had no stream (e.g. a
  // 'superseded' emitted at the moment it was reconnecting). Drop-with-client.
  if (client.pendingRemoteStateFrame) {
    const frame = client.pendingRemoteStateFrame;
    client.pendingRemoteStateFrame = null;
    try {
      res.write(`data: ${frame}\n\n`);
    } catch {}
  }
  if (stickyFrame) {
    try {
      res.write(`data: ${stickyFrame}\n\n`);
    } catch {}
  }
  const ka = setInterval(() => {
    try {
      res.write(': ka\n\n');
    } catch {}
  }, KEEPALIVE_MS);
  ka.unref?.();
  const cleanup = () => {
    clearInterval(ka);
    if (client.sse === res) client.sse = null;
    onClosed();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

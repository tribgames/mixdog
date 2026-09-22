// session-client/stream-link.mjs
// The live half of one session attachment: the /events frame stream, the
// reconnect policy that keeps it alive, and the one-shot fatal signal that
// tears both down exactly once. attachSession owns registration and calls; the
// stream's lifetime is owned here.
import { createFrameStream } from './frame-stream.mjs';
import { createStreamReconnect } from './stream-reconnect.mjs';

export const EVENT_STREAM_RECONNECT_BASE_MS = 1_000;
export const EVENT_STREAM_RECONNECT_MAX_MS = 30_000;
// Keepalive silence is detected independently
// from TCP close, and a continuously failing reconnect storm is bounded.
export const EVENT_STREAM_LIVENESS_TIMEOUT_MS = 45_000;
export const EVENT_STREAM_RECONNECT_BUDGET_MS = 10 * 60_000;

export function createStreamLink({
  discovery,
  port,
  serverToken,
  clientToken,
  onFrame,
  onFatal,
  onDisconnect,
  onReconnect,
  reconnectBaseMs,
  reconnectMaxMs,
  reconnectBudgetMs,
  livenessTimeoutMs,
  readDiscovery,
  probeHealth,
  pidAlive,
  log,
}) {
  let stopped = false;
  let fatalSignalled = false;
  const baseMs = Math.max(1, Number(reconnectBaseMs) || EVENT_STREAM_RECONNECT_BASE_MS);

  function teardown() {
    reconnect.stop();
    stream.destroy();
  }

  function signalFatal(reason) {
    if (stopped || fatalSignalled) return;
    fatalSignalled = true;
    teardown();
    try {
      onFatal(reason);
    } catch {}
  }

  const stream = createFrameStream({
    port,
    serverToken,
    clientToken,
    livenessMs: Math.max(1, Number(livenessTimeoutMs) || EVENT_STREAM_LIVENESS_TIMEOUT_MS),
    onFrame,
    log,
    onHealthy: () => reconnect.markHealthy(),
    onLoss: (reason) => reconnect.schedule(reason),
    onFatal: signalFatal,
  });
  const reconnect = createStreamReconnect({
    discovery,
    baseMs,
    maxMs: Math.max(baseMs, Number(reconnectMaxMs) || EVENT_STREAM_RECONNECT_MAX_MS),
    budgetMs: Math.max(baseMs, Number(reconnectBudgetMs) || EVENT_STREAM_RECONNECT_BUDGET_MS),
    log,
    readDiscovery,
    probeHealth,
    pidAlive,
    onDisconnect,
    onReconnect,
    onFatal: signalFatal,
    reopen: () => stream.open(),
  });

  return {
    open: () => stream.open(),
    stop: () => {
      stopped = true;
      teardown();
    },
  };
}

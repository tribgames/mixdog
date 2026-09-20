// session-client/stream-reconnect.mjs
// Recovering a lost frame stream: exponential backoff within a downtime
// budget, and — before each attempt — a check that the daemon behind the
// discovery file is still the one this attachment registered with (a
// replacement or an exited daemon is fatal: the owner must re-attach rather
// than keep knocking on a retired port).
export function createStreamReconnect({
  discovery,
  baseMs,
  maxMs,
  budgetMs,
  log,
  readDiscovery,
  probeHealth,
  pidAlive,
  onDisconnect,
  onReconnect,
  onFatal,
  reopen,
}) {
  let timer = null;
  let attempt = 0;
  let disconnectedAt = 0;
  let lastLossReason = '';
  let wasReady = false;
  let stopped = false;

  const budgetExhausted = (downtimeMs) => `${lastLossReason}; reconnect budget exhausted after ${downtimeMs}ms`;

  /** The discovery file now names another daemon that answers as itself. */
  async function replacedDaemon() {
    const current = readDiscovery();
    const replaced =
      current &&
      (Number(current.pid) !== Number(discovery.pid) ||
        Number(current.port) !== Number(discovery.port) ||
        String(current.token || '') !== String(discovery.token));
    if (!replaced) return null;
    const health = await probeHealth({ port: current.port, token: current.token, timeoutMs: 800 });
    return health && Number(health.pid) === Number(current.pid) ? current : null;
  }

  async function attemptReopen() {
    if (stopped) return;
    const downtimeMs = Math.max(0, Date.now() - disconnectedAt);
    if (downtimeMs >= budgetMs) {
      onFatal(budgetExhausted(downtimeMs));
      return;
    }
    const replacement = await replacedDaemon();
    if (replacement) {
      onFatal(
        `${lastLossReason}; daemon replaced` +
          ` oldPid=${Number(discovery.pid)} oldPort=${Number(discovery.port)}` +
          ` newPid=${Number(replacement.pid)} newPort=${Number(replacement.port)}`
      );
      return;
    }
    if (!pidAlive(discovery.pid)) {
      onFatal(`${lastLossReason}; daemon exited pid=${Number(discovery.pid)} port=${Number(discovery.port)}`);
      return;
    }
    reopen();
  }

  function schedule(reason) {
    if (stopped || timer) return;
    const now = Date.now();
    if (!disconnectedAt) {
      disconnectedAt = now;
      lastLossReason = String(reason || 'sse disconnected');
      try {
        onDisconnect({ reason: lastLossReason });
      } catch {}
    }
    const downtimeMs = Math.max(0, now - disconnectedAt);
    if (downtimeMs >= budgetMs) {
      onFatal(budgetExhausted(downtimeMs));
      return;
    }
    attempt += 1;
    const delayMs = Math.min(budgetMs - downtimeMs, maxMs, baseMs * 2 ** Math.min(attempt - 1, 8));
    log(`session event stream reconnecting attempt=${attempt} delayMs=${delayMs} reason=${lastLossReason}`);
    timer = setTimeout(() => {
      timer = null;
      attemptReopen().catch((error) => {
        log(`session event stream recovery probe failed: ${error?.message || error}`);
        reopen();
      });
    }, delayMs);
    timer.unref?.();
  }

  /** The stream delivered bytes: a recovery is reported once per outage and
   *  the backoff resets. */
  function markHealthy() {
    const reconnected =
      wasReady && disconnectedAt > 0
        ? { reason: lastLossReason, attempt, downtimeMs: Math.max(0, Date.now() - disconnectedAt) }
        : null;
    wasReady = true;
    attempt = 0;
    disconnectedAt = 0;
    lastLossReason = '';
    if (!reconnected) return;
    log(`session event stream reconnected attempt=${reconnected.attempt} downtimeMs=${reconnected.downtimeMs}`);
    try {
      onReconnect(reconnected);
    } catch {}
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { schedule, markHealthy, stop };
}

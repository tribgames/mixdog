// The turn gate on the initial MCP connect: a bounded wait, never a rejection.

// Turn gate: await the in-flight INITIAL connect, bounded by both the global
// server startup budget and the caller's TTFT grace. A server still
// connecting after the grace flows through the existing late-tool deferred
// announcement path unchanged.
export async function awaitInitialConnect({ state, mcpClient, resolveEffectiveMcpServers }, maxWaitMs = undefined) {
  const inFlight = state.mcpConnectInFlight;
  if (!inFlight) return;
  let budgetMs = 10000;
  try {
    // The gate must outlast the slowest enabled server's own startup budget;
    // a server with its budget disabled (0) means the connect may never
    // settle, so the whole gate is disabled (handled below).
    const configs = Object.values(resolveEffectiveMcpServers().servers).filter((cfg) => cfg?.enabled !== false);
    const budgets = (configs.length > 0 ? configs : [{}])
      .map((cfg) => mcpClient.resolveMcpStartupTimeoutMs?.(cfg))
      .filter((value) => Number.isFinite(value));
    if (budgets.length > 0) budgetMs = budgets.includes(0) ? 0 : Math.max(...budgets);
  } catch {
    /* fall back to default budget */
  }
  if (maxWaitMs !== null && maxWaitMs !== undefined) {
    const requestedMaxWaitMs = Number(maxWaitMs);
    if (Number.isFinite(requestedMaxWaitMs) && requestedMaxWaitMs >= 0) {
      budgetMs = Math.min(budgetMs, requestedMaxWaitMs);
    }
  }
  // Budget disabled (0/off) = no per-server startup timeout, so the connect
  // promise may never settle; never gate the turn on it — fall back to the
  // legacy fire-and-forget behavior (late servers use the deferred path).
  if (!(budgetMs > 0)) return;
  let timer = null;
  let expired = false;
  const budget = new Promise((resolveBudget) => {
    timer = setTimeout(() => {
      expired = true;
      resolveBudget();
    }, budgetMs);
  });
  try {
    // Follow replacement connects (a reconnect queued behind the captured
    // run installs a new in-flight promise) inside ONE fixed deadline.
    // Failures are already captured in state.mcpFailures, so rejections are
    // swallowed: this gate must never reject the turn.
    let current = inFlight;
    while (current && !expired) {
      await Promise.race([Promise.resolve(current).catch(() => {}), budget]);
      if (expired) break;
      // Let a queued reconnect install its promise before re-checking.
      await Promise.race([new Promise((resolveTick) => setImmediate(resolveTick)), budget]);
      current = state.mcpConnectInFlight;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

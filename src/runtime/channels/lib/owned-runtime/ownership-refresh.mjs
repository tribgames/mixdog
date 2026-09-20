// Daemon model: this runtime is the unconditional bridge owner, so a refresh
// just keeps the owned runtime in sync with channelBridgeActive.
export function createOwnershipRefresh({
  state,
  getBridgeRuntimeConnected,
  getChannelBridgeActive,
  startOwnedRuntime,
  stopOwnedRuntime,
}) {
  async function syncWithBridgeActivity(options) {
    if (!getChannelBridgeActive()) {
      if (getBridgeRuntimeConnected()) await stopOwnedRuntime('bridge inactive');
      return;
    }
    // Idempotent; early-returns when already connected.
    await startOwnedRuntime(options);
  }
  // Concurrent callers coalesce onto the in-flight refresh so provider tool
  // calls landing during a normal login wait for the same connect attempt
  // instead of observing a spurious auto-connect failure.
  async function refreshBridgeOwnership(options = {}) {
    if (state.refreshInFlight) return state.refreshInFlight;
    state.refreshInFlight = syncWithBridgeActivity(options);
    try {
      return await state.refreshInFlight;
    } finally {
      state.refreshInFlight = null;
    }
  }
  function refreshBridgeOwnershipSafe(options = {}) {
    refreshBridgeOwnership(options).catch((err) =>
      process.stderr.write(`[channels] refreshBridgeOwnership rejected: ${err?.message || err}\n`)
    );
  }
  return { refreshBridgeOwnership, refreshBridgeOwnershipSafe };
}

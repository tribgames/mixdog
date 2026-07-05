// Bridge ownership snapshot + owner heartbeat cluster. Extracted verbatim from
// channels/index.mjs (behavior-preserving). Self-contained: owns its own
// heartbeat timer + last-note dedup state, and depends only on the
// active-instance read/refresh primitives + identity, threaded as injected
// deps so the module reads live file-level references at call time.
function createOwnerHeartbeat({
  getInstanceId,
  readActiveInstance,
  refreshActiveInstance,
  OWNER_HEARTBEAT_INTERVAL_MS = 5e3,
}) {
  let lastOwnershipNote = "";
  let ownerHeartbeatTimer = null;

  function logOwnership(note) {
    if (lastOwnershipNote === note) return;
    lastOwnershipNote = note;
    process.stderr.write(`[ownership] ${note}
`);
  }
  function currentOwnerState() {
    const active = readActiveInstance();
    return {
      active,
      // Strict last-wins: this process owns the bridge ONLY when active-instance
      // names exactly this INSTANCE_ID. A newer remote session that claims the
      // seat overwrites instanceId, so the old owner immediately reads owned=false
      // and disconnects on its next refresh tick. No PID/terminal fallback —
      // that used to let a co-terminal worker wrongly self-claim.
      owned: active?.instanceId === getInstanceId()
    };
  }
  function getBridgeOwnershipSnapshot() {
    return currentOwnerState();
  }
  function claimBridgeOwnership(reason, options = {}) {
    // Returns true only when THIS instance actually holds the seat after the
    // write. With options.timeoutMs:0 (try-once) a contended lock throws
    // ELOCKCONTENDED — the caller catches it and treats the seat as busy.
    const refreshOpts = Number.isFinite(options.timeoutMs) ? { timeoutMs: options.timeoutMs } : undefined;
    const res = refreshActiveInstance(getInstanceId(), undefined, refreshOpts);
    const claimed = res?.instanceId === getInstanceId();
    if (claimed) logOwnership(`claimed owner (${reason})`);
    return claimed;
  }
  function startOwnerHeartbeat() {
    if (ownerHeartbeatTimer) return;
    ownerHeartbeatTimer = setInterval(() => {
      try {
        // Last-wins guard: only refresh the seat if we STILL own it. If a newer
        // remote session claimed active-instance.json since our last tick, do
        // NOT overwrite it back — that would re-steal ownership and cause
        // ping-pong / double backend connections. The bridgeOwnershipTimer's
        // refreshBridgeOwnership() will observe owned=false and disconnect us.
        // onlyIfOwned: re-checks ownership INSIDE the file lock so a newer
        // owner claiming the seat between currentOwnerState() and the locked
        // write is never overwritten (see refreshActiveInstance CAS guard).
        // Try-once (timeoutMs:0): the heartbeat must never block on the
        // active-instance lock. On contention refreshActiveInstance throws and
        // we simply skip this tick — the next tick catches up.
        if (currentOwnerState().owned) refreshActiveInstance(getInstanceId(), undefined, { onlyIfOwned: true, timeoutMs: 0 });
      } catch (e) {
        process.stderr.write(`[ownership] heartbeat refresh failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }, OWNER_HEARTBEAT_INTERVAL_MS);
    ownerHeartbeatTimer.unref?.();
  }
  function stopOwnerHeartbeat() {
    if (!ownerHeartbeatTimer) return;
    clearInterval(ownerHeartbeatTimer);
    ownerHeartbeatTimer = null;
  }

  return {
    logOwnership,
    currentOwnerState,
    getBridgeOwnershipSnapshot,
    claimBridgeOwnership,
    startOwnerHeartbeat,
    stopOwnerHeartbeat,
  };
}

export { createOwnerHeartbeat };

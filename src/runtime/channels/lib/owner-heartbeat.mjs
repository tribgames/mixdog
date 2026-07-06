// Bridge ownership snapshot + ownership logging. Ownership TRUTH now comes from
// the OS-enforced seat lock (lib/seat-lock.mjs): this process owns the bridge
// iff it holds the named-pipe/unix-socket listener. The old 5s file heartbeat +
// last-wins active-instance CAS is retired — a holder crash auto-releases the
// pipe and takeover is an explicit release message, so no periodic refresh or
// staleness eviction is needed. active-instance.json is now a pure metadata
// advert written elsewhere; it is no longer read to decide ownership.
function createOwnerHeartbeat({
  isSeatHeld,
}) {
  let lastOwnershipNote = "";

  function logOwnership(note) {
    if (lastOwnershipNote === note) return;
    lastOwnershipNote = note;
    process.stderr.write(`[ownership] ${note}
`);
  }
  function currentOwnerState() {
    // Ownership is exactly "do we hold the seat lock". No file read, no PID
    // heuristic, no staleness window.
    return { owned: isSeatHeld() === true };
  }
  function getBridgeOwnershipSnapshot() {
    return currentOwnerState();
  }

  return {
    logOwnership,
    currentOwnerState,
    getBridgeOwnershipSnapshot,
  };
}

export { createOwnerHeartbeat };

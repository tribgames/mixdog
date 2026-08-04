// Bridge ownership snapshot + ownership logging. Under the machine-global
// channels daemon (singleton-owner lock in src/standalone) there is exactly one
// runtime per machine, so this process is the unconditional bridge owner — the
// OS seat lock and its file heartbeat / last-wins CAS are retired.
// active-instance.json is now a pure metadata advert; it is no longer read to
// decide ownership.
function createOwnerHeartbeat() {
  let lastOwnershipNote = "";

  function logOwnership(note) {
    if (lastOwnershipNote === note) return;
    lastOwnershipNote = note;
    process.stderr.write(`[ownership] ${note}
`);
  }
  function currentOwnerState() {
    // Daemon singleton: this runtime always owns the bridge.
    return { owned: true };
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

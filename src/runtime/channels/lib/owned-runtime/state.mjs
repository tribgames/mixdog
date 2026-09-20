// Mutable lifecycle flags shared by the owned-runtime modules. One object so
// every phase (start / stop / refresh / reload) reads and writes the same
// in-flight markers instead of closing over file-level variables.
export function createOwnedRuntimeState() {
  return {
    // A startOwnedRuntime() run is between its first advert and its settle.
    bridgeRuntimeStarting: false,
    // stopOwnedRuntime() landed while an owned or automation start was in
    // flight; the in-flight run bails at its next checkpoint.
    stopRequested: false,
    // Resolves when the current startOwnedRuntime() run fully settles, so a
    // reload can wait before issuing a restart (lost-restart race).
    inFlightStart: null,
    // Automation (scheduler + webhook server + relay tunnel) can outlive a
    // failed/absent messaging provider; tracked apart from the connect flag.
    automationRunning: false,
    automationStartPromise: null,
    // Coalesces concurrent refreshBridgeOwnership() callers.
    refreshInFlight: null,
    selfHealing: false,
  };
}

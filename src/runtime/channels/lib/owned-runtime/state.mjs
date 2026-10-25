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
    // Automation (scheduler + webhook server + relay tunnel) can run without
    // the bridge being active; tracked apart from the bridge-connected flag.
    automationRunning: false,
    automationStartPromise: null,
  };
}

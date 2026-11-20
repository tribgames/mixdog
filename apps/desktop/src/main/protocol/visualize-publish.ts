// The visualize service's `publishRemote`: a change event goes to the core through the host role's publication queue
// (`host/state/set{key:'visualize'}`), the only path (it slims and orders every publication). A failure is reported
// through `onFailure` and never blocks the service; a missing host role is skipped (the claim's snapshot covers it).
export function createVisualizePublisher<E>(targets: {
  /** The host role's `publishVisualize`; absent while the host role is not built yet. */
  host(): ((event: E) => Promise<unknown>) | undefined;
  onFailure(target: 'host', error: unknown): void;
}): (event: E) => void {
  return (event) => {
    void targets
      .host()?.(event)
      .catch((error: unknown) => targets.onFailure('host', error));
  };
}

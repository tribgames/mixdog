// The visualize service's `publishRemote`, fanned out to both consumers of a change event: the Node daemon's remote
// mirror (until K1 removes it) and the core as `host/state/set{section:'visualize'}`. One event, published to both at
// the same moment. A failing consumer never blocks the other or the service, and its failure is reported through
// `onFailure` with the consumer's name.
export function createVisualizePublisher<E>(targets: {
  node(event: E): Promise<unknown>;
  /** The host role's `publishVisualize`; absent while the host role is not built yet. */
  host(): ((event: E) => Promise<unknown>) | undefined;
  onFailure(target: 'node' | 'host', error: unknown): void;
}): (event: E) => void {
  return (event) => {
    void targets.node(event).catch((error: unknown) => targets.onFailure('node', error));
    void targets.host()?.(event).catch((error: unknown) => targets.onFailure('host', error));
  };
}

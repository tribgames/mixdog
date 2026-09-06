interface EventSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

/** Geometry and desktop transitions invalidate observations; never auto-resume. */
export function bindComputerEnvironmentGuard(
  power: EventSource,
  displays: EventSource,
  invalidate: (reason: string) => void,
): () => void {
  const subscriptions: Array<[EventSource, string, (...args: any[]) => void]> = [];
  const bind = (source: EventSource, event: string, listener: (...args: any[]) => void) => {
    source.on(event, listener);
    subscriptions.push([source, event, listener]);
  };
  for (const event of ['lock-screen', 'suspend']) {
    bind(power, event, () => invalidate('desktop_unavailable'));
  }
  for (const event of ['display-added', 'display-removed']) {
    bind(displays, event, () => invalidate('display_changed'));
  }
  bind(displays, 'display-metrics-changed', (_event, _display, metrics: string[]) => {
    if (metrics?.some((metric) => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(metric))) {
      invalidate('display_changed');
    }
  });
  return () => {
    for (const [source, event, listener] of subscriptions) source.removeListener(event, listener);
  };
}

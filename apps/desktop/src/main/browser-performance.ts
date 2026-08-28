interface TraceAggregate {
  count: number;
  durationUs: number;
}

export class BrowserPerformanceTrace {
  readonly startedAt = Date.now();
  readonly #aggregates = new Map<string, TraceAggregate>();
  #events = 0;
  #dropped = 0;

  constructor(private readonly maxEvents = 200_000) {}

  add(events: unknown): void {
    if (!Array.isArray(events)) return;
    for (const raw of events) {
      if (!raw || typeof raw !== 'object') continue;
      if (this.#events >= this.maxEvents) {
        this.#dropped += 1;
        continue;
      }
      this.#events += 1;
      const event = raw as Record<string, unknown>;
      const name = String(event.name || '(unnamed)').slice(0, 120);
      const durationUs = Number.isFinite(Number(event.dur))
        ? Math.max(0, Number(event.dur))
        : 0;
      const aggregate = this.#aggregates.get(name) || { count: 0, durationUs: 0 };
      aggregate.count += 1;
      aggregate.durationUs += durationUs;
      this.#aggregates.set(name, aggregate);
    }
  }

  summary(endedAt = Date.now(), limit = 25): string {
    const top = [...this.#aggregates.entries()]
      .sort((left, right) => right[1].durationUs - left[1].durationUs
        || right[1].count - left[1].count)
      .slice(0, Math.max(1, limit));
    const lines = [
      `Trace duration: ${Math.max(0, endedAt - this.startedAt)}ms`,
      `Events: ${this.#events}${this.#dropped ? `; dropped after cap: ${this.#dropped}` : ''}`,
    ];
    if (top.length) {
      lines.push('Top trace events:');
      for (const [name, aggregate] of top) {
        lines.push(`- ${name}: ${aggregate.count} event(s), ${(aggregate.durationUs / 1000).toFixed(2)}ms total`);
      }
    }
    return lines.join('\n');
  }
}

export function formatPerformanceMetrics(
  metrics: Array<{ name?: string; value?: number }>,
): string {
  const preferred = [
    'Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes',
    'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration',
    'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize',
  ];
  const values = new Map(metrics.map((metric) => [String(metric.name || ''), Number(metric.value)]));
  const lines = preferred.flatMap((name) => {
    const value = Number(values.get(name));
    if (!Number.isFinite(value)) return [];
    if (/Size$/.test(name)) return [`- ${name}: ${(value / 1024 / 1024).toFixed(2)} MB`];
    if (/Duration$/.test(name)) return [`- ${name}: ${(value * 1000).toFixed(2)} ms`];
    return [`- ${name}: ${value}`];
  });
  return lines.length ? `Performance metrics:\n${lines.join('\n')}` : 'No performance metrics were returned.';
}

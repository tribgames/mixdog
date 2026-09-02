import type { WebContents } from 'electron';

import type { GuestSlot } from './guest-state';

interface TraceAggregate {
  count: number;
  durationUs: number;
}

export class BrowserPerformanceTrace {
  readonly startedAt = Date.now();
  readonly #aggregates = new Map<string, TraceAggregate>();
  #events = 0;
  #dropped = 0;

  constructor(
    private readonly maxEvents = 200_000,
    private readonly maxNames = 2_000,
  ) {}

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
      const requestedName = String(event.name || '(unnamed)').slice(0, 120);
      const name = this.#aggregates.has(requestedName)
        || this.#aggregates.size < this.maxNames
        ? requestedName
        : '(other)';
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

/** A trace that is still recording, plus the promise Chromium settles when it
 *  has handed over the last batch of events. */
export interface ActiveBrowserPerformanceTrace {
  trace: BrowserPerformanceTrace;
  complete: Promise<void>;
  resolveComplete: () => void;
}

export interface BrowserPerformanceCommandHost {
  guestDebugger(guest: WebContents): Promise<Electron.Debugger>;
  sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  /** Shared with the CDP listener that feeds and completes a running trace. */
  tracesByGuest: GuestSlot<ActiveBrowserPerformanceTrace>;
  settleAfterAction(guest: WebContents, signal?: AbortSignal): Promise<unknown>;
  pause(ms: number, signal?: AbortSignal): Promise<void>;
  cdpTimeoutMs: number;
}

const TRACE_COMPLETION_TIMEOUT_MS = 10_000;

export function createBrowserPerformanceCommands(host: BrowserPerformanceCommandHost) {
  const {
    guestDebugger,
    sendCdp,
    tracesByGuest,
    settleAfterAction,
    pause,
    cdpTimeoutMs,
  } = host;

  async function performanceResult(
    guest: WebContents,
    command: { operation?: string; reload?: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string }> {
    const operation = String(command.operation || 'metrics').toLowerCase();
    const cdp = await guestDebugger(guest);
    if (operation === 'metrics') {
      await sendCdp(guest, cdp, 'Performance.enable', {}, cdpTimeoutMs, signal);
      const result = await sendCdp<{ metrics?: Array<{ name?: string; value?: number }> }>(
        guest,
        cdp,
        'Performance.getMetrics',
        {},
        cdpTimeoutMs,
        signal,
      );
      return { text: formatPerformanceMetrics(result.metrics || []) };
    }
    if (operation === 'start') {
      if (tracesByGuest.has(guest)) {
        throw new Error('a performance trace is already running for this page');
      }
      let resolveComplete = () => {};
      const complete = new Promise<void>((resolve) => { resolveComplete = resolve; });
      const active: ActiveBrowserPerformanceTrace = {
        trace: new BrowserPerformanceTrace(),
        complete,
        resolveComplete,
      };
      tracesByGuest.set(guest, active);
      let tracingStarted = false;
      try {
        await sendCdp(guest, cdp, 'Tracing.start', {
          categories: 'devtools.timeline,v8.execute,blink.user_timing,loading,disabled-by-default-v8.cpu_profiler',
          options: 'sampling-frequency=10000',
          transferMode: 'ReportEvents',
        }, cdpTimeoutMs, signal);
        tracingStarted = true;
        if (command.reload) {
          guest.reload();
          await settleAfterAction(guest, signal);
        }
      } catch (error) {
        if (tracingStarted) {
          try {
            // Cancellation may be the reason setup failed, but cleanup must
            // still reach Chromium instead of inheriting the cancelled signal.
            await sendCdp(guest, cdp, 'Tracing.end', {}, cdpTimeoutMs);
            tracesByGuest.delete(guest);
          } catch (cleanupError) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; `
              + `trace cleanup also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}). `
              + 'Run performance with operation:"stop" to retry cleanup.',
            );
          }
        } else {
          tracesByGuest.delete(guest);
        }
        throw error;
      }
      return {
        text: `Performance trace started${command.reload ? ' and page reloaded' : ''}. Run performance with operation:"stop" after the scenario.`,
      };
    }
    if (operation === 'stop') {
      const active = tracesByGuest.get(guest);
      if (!active) return { text: 'No performance trace is running for this page.' };
      try {
        await sendCdp(guest, cdp, 'Tracing.end', {}, cdpTimeoutMs, signal);
        await Promise.race([
          active.complete,
          pause(TRACE_COMPLETION_TIMEOUT_MS, signal).then(() => {
            throw new Error('performance trace completion timed out');
          }),
        ]);
        return { text: `Performance trace stopped.\n${active.trace.summary()}` };
      } finally {
        tracesByGuest.delete(guest);
      }
    }
    throw new Error('performance operation must be metrics, start, or stop');
  }

  return { performanceResult };
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

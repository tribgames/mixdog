import {
  formatRemoteByteReport,
  type RemoteByteReport,
} from '../shared/remote-performance';

export type RemotePerformanceInfoWriter = (message: string) => void;

export function writeRemotePerformanceInfo(message: string): void {
  console.info(message);
}

export function reportRemoteByteWindow(
  report: RemoteByteReport,
  write: RemotePerformanceInfoWriter = writeRemotePerformanceInfo,
): void {
  write(formatRemoteByteReport(report));
}

export function reportRemoteFirstTranscript(
  elapsedMs: number,
  bytes: number,
  write: RemotePerformanceInfoWriter = writeRemotePerformanceInfo,
): void {
  write('[mixdog-remote-first-transcript]'
    + ` ms=${Math.max(0, Math.round(elapsedMs))}`
    + ` payload=${Math.round(Math.max(0, bytes) / 1024)}KB`);
}

export function createRemoteCallStats({
  reportWindowMs = 60_000,
  now = Date.now,
  write = writeRemotePerformanceInfo,
}: {
  reportWindowMs?: number;
  now?: () => number;
  write?: RemotePerformanceInfoWriter;
} = {}): {
  record(method: string, elapsedMs: number, bytes?: { requestBytes?: number; responseBytes?: number }): void;
  clear(): void;
} {
  const stats = new Map<string, { calls: number; ms: number; rx: number; tx: number }>();
  let since: number | null = null;
  const byteCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return {
    record(method, elapsedMs, bytes = {}): void {
      const current = now();
      since ??= current;
      const name = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(method) ? method : 'unknown';
      const row = stats.get(name) ?? { calls: 0, ms: 0, rx: 0, tx: 0 };
      row.calls += 1;
      row.ms += Math.max(0, Number(elapsedMs) || 0);
      row.rx += byteCount(bytes.requestBytes);
      row.tx += byteCount(bytes.responseBytes);
      stats.set(name, row);
      const windowMs = current - since;
      if (windowMs < reportWindowMs) return;
      const busiest = [...stats.entries()]
        .sort((left, right) => (right[1].rx + right[1].tx) - (left[1].rx + left[1].tx)
          || right[1].calls - left[1].calls)
        .slice(0, 8)
        .map(([entryName, entry]) => `${entryName}=${entry.calls}x/${Math.round(entry.ms)}ms`
          + `/rx-box=${entry.rx}B/tx-routed=${entry.tx}B`);
      const calls = [...stats.values()].reduce((total, entry) => total + entry.calls, 0);
      write(`[mixdog-remote-calls] ${Math.round(windowMs / 1000)}s calls=${calls}`
        + ` | ${busiest.join(' ')}`);
      stats.clear();
      since = null;
    },
    clear(): void { stats.clear(); since = null; },
  };
}

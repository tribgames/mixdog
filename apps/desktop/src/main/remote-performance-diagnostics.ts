import {
  bytesLabel,
  createLoopDelayProbe,
  type LoopDelayProbe,
  SOCKET_REPORT_INTERVAL_MS,
} from '../../../relay/lib/relay-diagnostics.mjs';
import { formatRemoteByteReport, type RemoteByteReport } from '../shared/remote-performance';

type RemotePerformanceInfoWriter = (message: string) => void;

/**
 * A periodic line with each relay socket's `bufferedAmount` (bytes the socket
 * accepted but the network has not taken yet) next to the event-loop delay.
 * The byte meter says how much was sent; this says whether the wire or the
 * process kept up. It runs only while a phone is attached: `sync()` is called
 * wherever the client count can change, and the timer exists only between a
 * first client and the last one leaving.
 */
export function createRemoteSocketDiagnostics({
  sample,
  intervalMs = SOCKET_REPORT_INTERVAL_MS,
  loopDelay = createLoopDelayProbe(),
  write = writeRemotePerformanceInfo,
  setTimer = setInterval,
  clearTimer = clearInterval,
}: {
  sample(): { clients: number; sockets: ReadonlyArray<{ name: string; bufferedAmount: number }> };
  intervalMs?: number;
  loopDelay?: LoopDelayProbe;
  write?: RemotePerformanceInfoWriter;
  setTimer?: (tick: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
}): { sync(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
    loopDelay.stop();
  };
  const tick = (): void => {
    const { clients, sockets } = sample();
    if (clients === 0) {
      stop();
      return;
    }
    const delay = loopDelay.take();
    write(
      `[mixdog-remote-sockets] ${Math.round(intervalMs / 1000)}s clients=${clients}` +
        ` buffered=${sockets.map((socket) => `${socket.name}:${bytesLabel(socket.bufferedAmount)}`).join(',')}` +
        ` loop-p50=${delay.p50.toFixed(1)}ms loop-p99=${delay.p99.toFixed(1)}ms loop-max=${delay.max.toFixed(1)}ms`
    );
  };
  return {
    sync(): void {
      if (sample().clients === 0) {
        stop();
        return;
      }
      if (timer) return;
      loopDelay.start();
      timer = setTimer(tick, intervalMs);
      timer.unref?.();
    },
    stop,
  };
}

function writeRemotePerformanceInfo(message: string): void {
  console.info(message);
}

export function reportRemoteByteWindow(
  report: RemoteByteReport,
  write: RemotePerformanceInfoWriter = writeRemotePerformanceInfo
): void {
  write(formatRemoteByteReport(report));
}

export function reportRemoteFirstTranscript(
  elapsedMs: number,
  bytes: number,
  write: RemotePerformanceInfoWriter = writeRemotePerformanceInfo
): void {
  write(
    '[mixdog-remote-first-transcript]' +
      ` ms=${Math.max(0, Math.round(elapsedMs))}` +
      ` payload=${Math.round(Math.max(0, bytes) / 1024)}KB`
  );
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
  const report = (windowMs: number): void => {
    const busiest = [...stats.entries()]
      .sort((left, right) => right[1].rx + right[1].tx - (left[1].rx + left[1].tx) || right[1].calls - left[1].calls)
      .slice(0, 8)
      .map(
        ([entryName, entry]) =>
          `${entryName}=${entry.calls}x/${Math.round(entry.ms)}ms` + `/rx-box=${entry.rx}B/tx-routed=${entry.tx}B`
      );
    const calls = [...stats.values()].reduce((total, entry) => total + entry.calls, 0);
    write(`[mixdog-remote-calls] ${Math.round(windowMs / 1000)}s calls=${calls}` + ` | ${busiest.join(' ')}`);
  };
  return {
    record(method, elapsedMs, bytes = {}): void {
      const current = now();
      since ??= current;
      // A method, optionally keyed by the capability names it carried
      // (`invokeCapability:getFoo`, `readCapabilities:getA+getB`).
      const name = /^[A-Za-z][A-Za-z0-9_]{0,79}(?::[A-Za-z0-9_+]{1,512})?$/.test(method) ? method : 'unknown';
      const row = stats.get(name) ?? { calls: 0, ms: 0, rx: 0, tx: 0 };
      row.calls += 1;
      row.ms += Math.max(0, Number(elapsedMs) || 0);
      row.rx += byteCount(bytes.requestBytes);
      row.tx += byteCount(bytes.responseBytes);
      stats.set(name, row);
      const windowMs = current - since;
      if (windowMs < reportWindowMs) return;
      report(windowMs);
      stats.clear();
      since = null;
    },
    /** The last phone left: report the partial window instead of losing it
     *  (a phone typically stays under a minute per visit). */
    clear(): void {
      if (since !== null && stats.size > 0) report(now() - since);
      stats.clear();
      since = null;
    },
  };
}

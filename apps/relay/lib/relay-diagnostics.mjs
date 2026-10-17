// Periodic socket diagnostics: each relay socket's `bufferedAmount` (bytes the
// socket accepted that the network has not taken yet) beside the relay's
// event-loop delay. Bytes forwarded say how much moved; this says whether the
// wire or the process kept up. Written to the relay's own log channel
// (console.log, `[relay] …`) and only while at least one phone is connected.
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const SOCKET_REPORT_INTERVAL_MS = 30_000;
/** The largest sockets named on one line; the rest are summed. */
const MAX_LISTED_SOCKETS = 12;
/** Event-loop delay sampling period while a probe runs. */
const LOOP_DELAY_RESOLUTION_MS = 20;

/** `bytes` as a short log label (`812B`, `3.4KB`). Shared with the desktop's
 *  own socket report (main/remote-performance-diagnostics.ts). */
export function bytesLabel(bytes) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${Math.max(0, Math.floor(bytes))}B`;
}

/** Event-loop delay over one reporting window: `take()` returns p50/p99/max
 *  in milliseconds since the last take (or start) and opens a fresh window. */
export function createLoopDelayProbe() {
  const histogram = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  const ms = (nanoseconds) => (Number.isFinite(nanoseconds) ? nanoseconds / 1e6 : 0);
  return {
    start: () => {
      histogram.enable();
    },
    stop: () => {
      histogram.disable();
      histogram.reset();
    },
    take: () => {
      const window = { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max) };
      histogram.reset();
      return window;
    },
  };
}

/** The sockets of every desktop that has a phone attached, and the phone count. */
export function collectSockets(liveDesktops) {
  const sockets = [];
  let phones = 0;
  for (const [deviceId, entry] of liveDesktops) {
    if (entry.clients.size === 0) continue;
    phones += entry.clients.size;
    sockets.push({
      name: `desktop:${String(deviceId).slice(0, 8)}`,
      bufferedAmount: entry.socket?.bufferedAmount || 0,
    });
    for (const [clientId, phone] of entry.clients) {
      sockets.push({ name: `phone:${String(clientId).slice(0, 8)}`, bufferedAmount: phone.bufferedAmount || 0 });
    }
  }
  return { phones, sockets };
}

export function formatSocketReport({ phones, sockets, loop, intervalMs }) {
  const ordered = [...sockets].sort((left, right) => right.bufferedAmount - left.bufferedAmount);
  const listed = ordered.slice(0, MAX_LISTED_SOCKETS);
  const rest = ordered.slice(MAX_LISTED_SOCKETS);
  const buffered = listed.map((socket) => `${socket.name}=${bytesLabel(socket.bufferedAmount)}`);
  if (rest.length > 0) {
    buffered.push(
      `+${rest.length} more=${bytesLabel(rest.reduce((total, socket) => total + socket.bufferedAmount, 0))}`
    );
  }
  return (
    `[relay] sockets ${Math.round(intervalMs / 1000)}s phones=${phones} buffered ${buffered.join(' ')}` +
    ` loop-p50=${loop.p50.toFixed(1)}ms loop-p99=${loop.p99.toFixed(1)}ms loop-max=${loop.max.toFixed(1)}ms`
  );
}

/** How often the relay looks for a connection to start or stop sampling. */
const WATCH_INTERVAL_MS = 5_000;

/** A desktop leg or a phone is attached. */
function anyConnection(liveDesktops) {
  for (const entry of liveDesktops.values()) if (entry.socket || entry.clients.size > 0) return true;
  return false;
}

/**
 * Writes one line every `intervalMs`, and only when a phone is connected. The
 * event-loop sampler runs only while some desktop or phone is connected: a
 * cheap watch tick starts it when the first connection appears and stops it
 * when the last one is gone, so an idle relay pays no sampling timer. Each report
 * covers the window since the previous one (or since sampling started).
 */
export function startSocketDiagnostics({
  liveDesktops,
  intervalMs = SOCKET_REPORT_INTERVAL_MS,
  write = console.log,
  loopDelay = createLoopDelayProbe(),
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  const watchMs = Math.min(WATCH_INTERVAL_MS, intervalMs);
  const ticksPerReport = Math.max(1, Math.round(intervalMs / watchMs));
  let sampling = false;
  let ticks = 0;
  const timer = setTimer(() => {
    if (!anyConnection(liveDesktops)) {
      if (sampling) loopDelay.stop();
      sampling = false;
      ticks = 0;
      return;
    }
    if (!sampling) {
      loopDelay.start();
      sampling = true;
      ticks = 0;
    }
    ticks += 1;
    if (ticks < ticksPerReport) return;
    ticks = 0;
    const loop = loopDelay.take();
    const { phones, sockets } = collectSockets(liveDesktops);
    if (phones === 0) return;
    write(formatSocketReport({ phones, sockets, loop, intervalMs }));
  }, watchMs);
  timer.unref?.();
  return {
    stop: () => {
      clearTimer(timer);
      if (sampling) loopDelay.stop();
      sampling = false;
    },
  };
}

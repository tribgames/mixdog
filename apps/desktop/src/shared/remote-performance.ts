interface RemoteByteLaneTotal {
  lane: string;
  bytes: number;
  frames: number;
}

export interface RemoteByteReport {
  windowMs: number;
  frames: number;
  bytes: number;
  lanes: RemoteByteLaneTotal[];
}

interface RemoteByteMeter {
  /** Returns a report only on the call that closes a window. */
  record(payload: unknown, bytes: number): RemoteByteReport | null;
  /** Drops the window, answering what it held so a partial visit (a phone
   *  typically stays under a minute) is still reported. */
  clear(): RemoteByteReport | null;
}

/** What a compact frame actually carried. Two frames both named `compact:T`
 *  can be a six-byte streamed suffix and a whole rebuilt state block; only the
 *  shape separates them, and only the field names say which block keeps
 *  moving while the screen does not. */
function compactFrameShape(wire: unknown): string {
  if (!wire || typeof wire !== 'object') return '';
  const record = wire as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['ip', 'ta', 'tt', 'sd', 'sl', 'streamingTail']) {
    if (Object.hasOwn(record, key)) parts.push(key);
  }
  const changed = record.sc;
  if (changed && typeof changed === 'object') {
    const fields = Object.keys(changed as Record<string, unknown>).sort();
    parts.push(fields.length > 0 ? `sc(${fields.slice(0, 4).join(',')})` : 'sc');
  }
  return parts.length > 0 ? `:${parts.join('+')}` : ':idle';
}

/** Which lane a payload belongs to, read from the shapes remote-relay.ts
 *  actually sends: a named `event`, a compact-wire `e` tag, or an RPC answer
 *  carrying an `id`. */
export function remoteFrameLane(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'other';
  const record = payload as { event?: unknown; e?: unknown; id?: unknown; w?: unknown };
  if (typeof record.event === 'string' && record.event) return record.event;
  if (typeof record.e === 'string' && record.e) {
    return `compact:${record.e}${compactFrameShape(record.w)}`;
  }
  if (record.id !== undefined) return 'rpc';
  return 'other';
}

export function formatRemoteByteReport(report: RemoteByteReport): string {
  const size = (bytes: number): string =>
    bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(2)}MB` : `${Math.round(bytes / 1024)}KB`;
  const share = (bytes: number): string => (report.bytes > 0 ? `${Math.round((bytes / report.bytes) * 100)}%` : '0%');
  const seconds = Math.max(1, report.windowMs / 1000);
  const lanes = report.lanes
    .map((lane) => `${lane.lane}=${size(lane.bytes)}(${share(lane.bytes)},${lane.frames}f)`)
    .join(' ');
  return (
    `[mixdog-remote-meter] ${Math.round(seconds)}s` +
    ` frames=${report.frames} total=${size(report.bytes)}` +
    ` rate=${(report.bytes / seconds / 1024).toFixed(1)}KB/s` +
    ' direction=desktop-to-relay unit=ws-message' +
    (lanes ? ` | ${lanes}` : '')
  );
}

/** Measures application message bytes, including encryption and relay routing,
 *  but excluding WebSocket/TLS/TCP/IP headers. This is not a billing counter.
 *  The relay itself cannot break this down:
 *  every phone-leg payload is E2EE ciphertext by the time it arrives there, so
 *  the lane that owns a byte is knowable HERE or nowhere. The caller decides
 *  whether it runs; the meter itself is two integer adds per frame. */
export function createRemoteByteMeter({
  enabled,
  windowMs = 60_000,
  now = Date.now,
}: {
  enabled: boolean;
  windowMs?: number;
  now?: () => number;
}): RemoteByteMeter {
  const lanes = new Map<string, { bytes: number; frames: number }>();
  let frames = 0;
  let bytes = 0;
  let windowStartedAt: number | null = null;
  const reset = (): void => {
    lanes.clear();
    frames = 0;
    bytes = 0;
    windowStartedAt = null;
  };
  const take = (elapsed: number): RemoteByteReport => {
    const report: RemoteByteReport = {
      windowMs: elapsed,
      frames,
      bytes,
      lanes: [...lanes]
        .map(([name, total]) => ({ lane: name, bytes: total.bytes, frames: total.frames }))
        .sort((left, right) => right.bytes - left.bytes),
    };
    reset();
    return report;
  };
  return {
    record(payload, size): RemoteByteReport | null {
      if (!enabled || !Number.isFinite(size) || size <= 0) return null;
      const current = now();
      windowStartedAt ??= current;
      const lane = remoteFrameLane(payload);
      const entry = lanes.get(lane) ?? { bytes: 0, frames: 0 };
      entry.bytes += size;
      entry.frames += 1;
      lanes.set(lane, entry);
      frames += 1;
      bytes += size;
      // A window closes on the first frame past its edge: an idle leg reports
      // nothing rather than emitting empty windows forever.
      const elapsed = current - windowStartedAt;
      if (elapsed < windowMs) return null;
      return take(elapsed);
    },
    clear(): RemoteByteReport | null {
      if (windowStartedAt === null || frames === 0) {
        reset();
        return null;
      }
      return take(now() - windowStartedAt);
    },
  };
}

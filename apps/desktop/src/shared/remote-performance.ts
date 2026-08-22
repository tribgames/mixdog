export interface RemotePaintProbe {
  id: string;
}

export interface RemotePaintMeasurement {
  id: string;
  sessionId: string;
  roundTripMs: number;
  receiveToPaintMs: number;
}

export interface RemotePaintProbeTracker {
  issue(sessionId: string): RemotePaintProbe | null;
  acknowledgeFrame(frame: unknown): RemotePaintMeasurement | null;
  clear(): void;
}

export function isRemotePaintProbe(value: unknown): value is RemotePaintProbe {
  const probe = value as Partial<RemotePaintProbe> | null;
  return Boolean(probe && typeof probe.id === "string" && probe.id.length > 0);
}

export function createRemotePaintProbeTracker({
  enabled,
  intervalMs = 1_000,
  expiryMs = 30_000,
  now = Date.now,
}: {
  enabled: boolean;
  intervalMs?: number;
  expiryMs?: number;
  now?: () => number;
}): RemotePaintProbeTracker {
  let sequence = 0;
  const lastIssuedAt = new Map<string, number>();
  const pending = new Map<string, { sessionId: string; issuedAt: number }>();
  const prune = (current: number): void => {
    for (const [id, entry] of pending) {
      if (current - entry.issuedAt > expiryMs) pending.delete(id);
    }
  };
  return {
    issue(sessionId): RemotePaintProbe | null {
      if (!enabled || !sessionId) return null;
      const current = now();
      const previous = lastIssuedAt.get(sessionId) ?? Number.NEGATIVE_INFINITY;
      if (current - previous < intervalMs) return null;
      prune(current);
      lastIssuedAt.set(sessionId, current);
      const id = `${sessionId}:${++sequence}`;
      pending.set(id, { sessionId, issuedAt: current });
      return { id };
    },
    acknowledgeFrame(frame): RemotePaintMeasurement | null {
      if (!enabled || !frame || typeof frame !== "object") return null;
      const record = frame as { method?: unknown; params?: unknown };
      if (record.method !== "remotePerfPaint" || !Array.isArray(record.params)) return null;
      const id = String(record.params[0] || "");
      const receiveToPaintMs = Number(record.params[1]);
      const entry = pending.get(id);
      if (!entry || !Number.isFinite(receiveToPaintMs) || receiveToPaintMs < 0) return null;
      pending.delete(id);
      return {
        id,
        sessionId: entry.sessionId,
        roundTripMs: Math.max(0, now() - entry.issuedAt),
        receiveToPaintMs,
      };
    },
    clear(): void {
      lastIssuedAt.clear();
      pending.clear();
    },
  };
}

export interface RemoteByteLaneTotal {
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

export interface RemoteByteMeter {
  /** Returns a report only on the call that closes a window. */
  record(payload: unknown, bytes: number): RemoteByteReport | null;
  clear(): void;
}

/** Which lane a payload belongs to, read from the shapes remote-relay.ts
 *  actually sends: a named `event`, a compact-wire `e` tag, or an RPC answer
 *  carrying an `id`. */
export function remoteFrameLane(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "other";
  const record = payload as { event?: unknown; e?: unknown; id?: unknown };
  if (typeof record.event === "string" && record.event) return record.event;
  if (typeof record.e === "string" && record.e) return `compact:${record.e}`;
  if (record.id !== undefined) return "rpc";
  return "other";
}

export function formatRemoteByteReport(report: RemoteByteReport): string {
  const size = (bytes: number): string => (bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(2)}MB`
    : `${Math.round(bytes / 1024)}KB`);
  const share = (bytes: number): string => (report.bytes > 0
    ? `${Math.round((bytes / report.bytes) * 100)}%`
    : "0%");
  const seconds = Math.max(1, report.windowMs / 1000);
  const lanes = report.lanes
    .map((lane) => `${lane.lane}=${size(lane.bytes)}(${share(lane.bytes)},${lane.frames}f)`)
    .join(" ");
  return `[mixdog-remote-meter] ${Math.round(seconds)}s`
    + ` frames=${report.frames} total=${size(report.bytes)}`
    + ` rate=${(report.bytes / seconds / 1024).toFixed(1)}KB/s`
    + (lanes ? ` | ${lanes}` : "");
}

/** Measures what this desktop puts on the wire, in the SAME unit the relay
 *  bills (the declared frame length). The relay itself cannot break this down:
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
  let windowStartedAt = now();
  const reset = (current: number): void => {
    lanes.clear();
    frames = 0;
    bytes = 0;
    windowStartedAt = current;
  };
  return {
    record(payload, size): RemoteByteReport | null {
      if (!enabled || !Number.isFinite(size) || size <= 0) return null;
      const lane = remoteFrameLane(payload);
      const entry = lanes.get(lane) ?? { bytes: 0, frames: 0 };
      entry.bytes += size;
      entry.frames += 1;
      lanes.set(lane, entry);
      frames += 1;
      bytes += size;
      // A window closes on the first frame past its edge: an idle leg reports
      // nothing rather than emitting empty windows forever.
      const current = now();
      const elapsed = current - windowStartedAt;
      if (elapsed < windowMs) return null;
      const report: RemoteByteReport = {
        windowMs: elapsed,
        frames,
        bytes,
        lanes: [...lanes]
          .map(([name, total]) => ({ lane: name, bytes: total.bytes, frames: total.frames }))
          .sort((left, right) => right.bytes - left.bytes),
      };
      reset(current);
      return report;
    },
    clear(): void {
      reset(now());
    },
  };
}

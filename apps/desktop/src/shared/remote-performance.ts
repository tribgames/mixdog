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

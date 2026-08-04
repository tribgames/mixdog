import type { VirtualItem } from "@tanstack/react-virtual";

/**
 * Per-session virtual geometry, kept across visits.
 *
 * Re-entering a session must paint at its exact previous geometry, so the
 * timeline hands its REAL measurements (`takeSnapshot`) to the next mount
 * instead of replaying an estimate-then-correct cascade. Cold rows start from
 * one flat estimate; the first measurement replaces it.
 */
export const TRANSCRIPT_ROW_ESTIMATE = 60;
export const TRANSCRIPT_VIRTUAL_OVERSCAN = 20;
export const TRANSCRIPT_BOTTOM_SPACER = 64;
export const TRANSCRIPT_VIRTUAL_CACHE_LIMIT = 16;

export interface TranscriptVirtualSnapshot {
  measurements?: VirtualItem[];
  offset: number;
  atEnd: boolean;
}

const snapshots = new Map<string, TranscriptVirtualSnapshot>();

function remember(sessionKey: string, snapshot: TranscriptVirtualSnapshot): void {
  snapshots.delete(sessionKey);
  snapshots.set(sessionKey, snapshot);
  while (snapshots.size > TRANSCRIPT_VIRTUAL_CACHE_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function readTranscriptVirtualSnapshot(
  sessionKey: string,
): TranscriptVirtualSnapshot | undefined {
  return sessionKey ? snapshots.get(sessionKey) : undefined;
}

/** Scroll ownership while the session is on screen. */
export function rememberTranscriptVirtualOffset(
  sessionKey: string,
  offset: number,
  atEnd: boolean,
): void {
  if (!sessionKey) return;
  const current = snapshots.get(sessionKey);
  remember(sessionKey, {
    measurements: current?.measurements,
    offset: Math.max(0, Number(offset) || 0),
    atEnd,
  });
}

/** Final geometry handed over when the session leaves the screen. */
export function rememberTranscriptVirtualMeasurements(
  sessionKey: string,
  measurements: VirtualItem[],
): void {
  if (!sessionKey) return;
  const current = snapshots.get(sessionKey);
  const measured = measurements.length > 0;
  remember(sessionKey, {
    measurements: measured ? measurements : current?.measurements,
    offset: current?.offset ?? 0,
    atEnd: current?.atEnd ?? true,
  });
}

export function clearTranscriptVirtualSnapshots(): void {
  snapshots.clear();
}

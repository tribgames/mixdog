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
// OpenCode reserves 64px because its prompt dock FLOATS over the scroll view
// (the padding is dock clearance behind a translucent overlay). Mixdog's
// composer sits in flow BELOW the viewport, so the same 64px rendered as pure
// empty space above the composer (user: 하단 여백이 많다). 24px keeps the
// last message's breathing room without a dead band.
export const TRANSCRIPT_BOTTOM_SPACER = 24;
export const TRANSCRIPT_VIRTUAL_CACHE_LIMIT = 16;

export interface TranscriptVirtualSnapshot {
  measurements?: VirtualItem[];
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
  });
}

export function clearTranscriptVirtualSnapshots(): void {
  snapshots.clear();
}

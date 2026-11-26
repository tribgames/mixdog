import type { VirtualItem } from '@tanstack/react-virtual';
import { getChatTextScale } from './chat-text-size-preference';

export const TRANSCRIPT_ROW_ESTIMATE = 60;
// Rows per side mounted past the view before the viewport is measured, and what a first paint prepares
// (session-open-intent.ts). A measured list mounts a viewport height per side instead
// (transcript-list-virtualizer.ts `transcriptMountMargin`).
export const TRANSCRIPT_VIRTUAL_OVERSCAN = 10;
/** The shortest row the list paints: the live band's line (desktop/12-transcript.css). */
export const TRANSCRIPT_MIN_ROW_PX = 24;
/** Deterministic initial row height priors for coding transcripts (12-transcript.css / 14-live-activity.css). */
export const TRANSCRIPT_THINKING_ROW_PX = 24;
export const TRANSCRIPT_BAND_LEAD_PX = 16;
export const TRANSCRIPT_LIVE_ASSISTANT_ROW_PX = 24;
export const TRANSCRIPT_COLLAPSED_TOOL_ROW_PX = 30;
export const TRANSCRIPT_PART_STEP_PX = 8;
export const TRANSCRIPT_AFTER_CHANGES_STEP_PX = 20;
export const TRANSCRIPT_DIVIDER_STEP_PX = 24;
// Breathing room above the measured composer footprint. The footprint itself
// is supplied by the dock, never guessed from an expected number of controls.
export const TRANSCRIPT_BOTTOM_SPACER = 24;
const TRANSCRIPT_VIRTUAL_CACHE_LIMIT = 16;
/** Set on the viewport while the list owes a re-estimate of its unmeasured
 *  rows (transcript-list-estimates.ts): its geometry is not final yet. */
export const TRANSCRIPT_RELEARN_ATTRIBUTE = 'data-transcript-relearn';

interface TranscriptVirtualSnapshot {
  measurements?: VirtualItem[];
}

/** The chat text scale a session's remembered row sizes were measured under: sizes of another scale are not sizes of
 *  these rows. Sizes of another width are kept: the list re-measures the rows it mounts in one pass
 *  (transcript-list-resize-patch.ts), and the rest are what was measured when the list is that wide again. */
const bases = new Map<string, number>();

const snapshots = new Map<string, TranscriptVirtualSnapshot>();
// A materialized draft keeps the row-key namespace it painted with.
const namespaces = new Map<string, string>();
let draftNamespaces = 0;

export function nextDraftTranscriptNamespace(): string {
  draftNamespaces += 1;
  return `draft-${draftNamespaces}`;
}

/** The namespace a session's rows are keyed with — its own, unless it was
 *  promoted from a draft whose namespace its cached geometry still uses. */
export function transcriptRowNamespace(sessionKey: string): string {
  return namespaces.get(sessionKey) || sessionKey;
}

export function rememberTranscriptRowNamespace(sessionKey: string, namespace: string): void {
  if (!sessionKey || !namespace || sessionKey === namespace) return;
  namespaces.delete(sessionKey);
  namespaces.set(sessionKey, namespace);
  while (namespaces.size > TRANSCRIPT_VIRTUAL_CACHE_LIMIT) {
    const oldest = namespaces.keys().next().value;
    if (oldest === undefined) break;
    namespaces.delete(oldest);
  }
}

function remember(sessionKey: string, snapshot: TranscriptVirtualSnapshot): void {
  snapshots.delete(sessionKey);
  snapshots.set(sessionKey, snapshot);
  while (snapshots.size > TRANSCRIPT_VIRTUAL_CACHE_LIMIT) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
    bases.delete(oldest);
  }
}

/** The sizes remembered of the session's rows, while they are sizes at the chat text scale in use. Where a reader was
 *  is not kept here: it outlives these (transcript-list-reader-place.ts). */
export function readTranscriptVirtualSnapshot(sessionKey: string): TranscriptVirtualSnapshot | undefined {
  if (!sessionKey) return undefined;
  const scale = bases.get(sessionKey);
  if (scale !== undefined && scale !== getChatTextScale()) return undefined;
  return snapshots.get(sessionKey);
}

/** Final geometry handed over when the session leaves the screen. */
export function rememberTranscriptVirtualMeasurements(sessionKey: string, measurements: VirtualItem[]): void {
  if (!sessionKey) return;
  const current = readTranscriptVirtualSnapshot(sessionKey);
  const measured = measurements.length > 0;
  remember(sessionKey, {
    measurements: measured ? measurements : current?.measurements,
  });
  bases.set(sessionKey, getChatTextScale());
}

/** Lets go of everything remembered of the session's list. */
export function forgetTranscriptVirtualSnapshot(sessionKey: string): void {
  snapshots.delete(sessionKey);
  bases.delete(sessionKey);
}

/** The rows whose sizes are remembered, over every session: what the cache holds. */
export function transcriptVirtualCacheStats(): { sessions: number; rows: number } {
  let rows = 0;
  for (const snapshot of snapshots.values()) rows += snapshot.measurements?.length ?? 0;
  return { sessions: snapshots.size, rows };
}

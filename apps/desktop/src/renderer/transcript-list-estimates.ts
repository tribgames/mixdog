import { type MutableRefObject, type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { handoffLinesAt, roomPassIsQuiet, routineReplyIsQuiet, taskReportHidden } from './agent-chat-place';
import { coreScrollState, measureTranscriptRow, type TranscriptVirtualizer } from './transcript-list-geometry';
import {
  type TranscriptRowSurface,
  transcriptRowHeightStore,
  transcriptRowInitialPrior,
} from './transcript-row-estimates';
import { useSessionAttentionIndex } from './session-attention-index';
import type { TranscriptRowModel } from './transcript-rows';
import { TRANSCRIPT_RELEARN_ATTRIBUTE, TRANSCRIPT_ROW_ESTIMATE } from './transcript-virtual-cache';

/** Whether a row's painting depends on other rows: the rows that carry a
 *  turn's hand-off lines (its live band, its last reply, a round of a turn
 *  with no reply), and a task report a hand-off line makes quiet. */
const variesWithContext = (row: TranscriptRowModel | undefined) =>
  row?._tag === 'ToolActivity' || row?._tag === 'Thinking' || row?._tag === 'AssistantPart';

/** `lines:N` for the N hand-off lines a row carries, `hidden` for a task report that paints nothing, '' otherwise. The
 *  height store learns each apart; the list marks each painted row with it (TranscriptList.tsx data-variant). */
export function transcriptRowVariant(
  rows: readonly TranscriptRowModel[],
  index: number,
  /** Sessions waiting for the user now: a wait report shows only for them. */
  waiting: ReadonlySet<string>
): string {
  if (!variesWithContext(rows[index])) return '';
  if (taskReportHidden(rows, index, waiting)) return 'hidden';
  const lines = handoffLinesAt(rows, index).length;
  return lines ? `lines:${lines}` : '';
}

const paintsNothing = (row: TranscriptRowModel, variant: string, surface: TranscriptRowSurface) =>
  variant === 'hidden' ||
  (row._tag === 'AssistantPart' && (roomPassIsQuiet(row.item) || routineReplyIsQuiet(row.item))) ||
  (row._tag === 'Thinking' && surface === 'room' && !variant);

export function useTranscriptRowEstimates({
  rowsRef,
  viewport,
  hasScrollGestureRef,
  surfaceRef,
}: {
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  viewport: RefObject<HTMLDivElement | null>;
  hasScrollGestureRef: MutableRefObject<() => boolean>;
  /** Who paints the rows; read at each estimate (a chat's mode can arrive
   *  with the session catalog, after the list mounted). */
  surfaceRef: MutableRefObject<TranscriptRowSurface>;
}) {
  const waitingRef = useRef<ReadonlySet<string>>(new Set());
  waitingRef.current = useSessionAttentionIndex().needsUser;
  const timelineWidth = useRef(0);
  const virtualizerRefForEstimates = useRef<TranscriptVirtualizer | null>(null);
  const endPinForEstimates = useRef<(() => void) | null>(null);
  const heldEstimates = useRef(new Map<unknown, number>());
  // The variant each held estimate was taken under: a round whose lines
  // changed since is estimated again, not held at its old size.
  const heldVariants = useRef(new Map<unknown, string>());
  const fallbackEstimates = useRef(new Set<unknown>());
  const estimateRow = useCallback(
    (index: number) => {
      const row = rowsRef.current[index];
      if (!row) return TRANSCRIPT_ROW_ESTIMATE;
      const held = heldEstimates.current.get(row.key);
      if (held !== undefined && !variesWithContext(row)) return held;
      const variant = transcriptRowVariant(rowsRef.current, index, waitingRef.current);
      if (held !== undefined && (heldVariants.current.get(row.key) ?? '') === variant) return held;
      heldEstimates.current.delete(row.key);
      fallbackEstimates.current.delete(row.key);
      if (variant) heldVariants.current.set(row.key, variant);
      else heldVariants.current.delete(row.key);
      const surface = surfaceRef.current;
      if (paintsNothing(row, variant, surface)) {
        heldEstimates.current.set(row.key, 0);
        return 0;
      }
      const prior = transcriptRowInitialPrior(rowsRef.current, index, surface);
      // Before the viewport's first observation only: one width read at mount.
      if (!timelineWidth.current) timelineWidth.current = viewport.current?.clientWidth ?? 0;
      if (!timelineWidth.current) return prior ?? TRANSCRIPT_ROW_ESTIMATE;
      const store = transcriptRowHeightStore();
      // Deterministic priors (Thinking, newly mounted live AssistantPart, collapsed ToolActivity)
      // hold their layout-exact size without enqueueing fallbackEstimates -> relearnEstimates().
      if (store.knows(row, timelineWidth.current, surface, variant)) {
        const estimate = store.estimate(row, timelineWidth.current, surface, variant);
        heldEstimates.current.set(row.key, estimate);
        return estimate;
      }
      if (prior !== null) {
        heldEstimates.current.set(row.key, prior);
        return prior;
      }
      fallbackEstimates.current.add(row.key);
      const estimate = store.estimate(row, timelineWidth.current, surface, variant);
      heldEstimates.current.set(row.key, estimate);
      return estimate;
    },
    [rowsRef, viewport, surfaceRef]
  );
  // The sizes kept are those of the rows the list holds: once they outnumber the rows (the window let rows go), a row
  // that left takes its estimate, its variant and its measured size with it. It is measured again if it is read again.
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    const sizes = virtualizerRefForEstimates.current?.itemSizeCache as Map<unknown, number> | undefined;
    const kept = [heldEstimates.current, heldVariants.current, fallbackEstimates.current, sizes];
    if (!kept.some((held) => held !== undefined && held.size > rows.length)) return;
    const keys = new Set<unknown>(rows.map((row) => row.key));
    for (const held of kept) {
      if (!held) continue;
      for (const key of [...held.keys()]) if (!keys.has(key)) held.delete(key);
    }
  });
  const relearnFrame = useRef(0);
  // Marked on the viewport while a relearn waits for its frame: the entry
  // reveal (use-transcript-reveal.ts) never takes a revisit as final then.
  useEffect(
    () => () => {
      viewport.current?.removeAttribute(TRANSCRIPT_RELEARN_ATTRIBUTE);
    },
    [viewport]
  );
  const relearnEstimates = useCallback(() => {
    if (relearnFrame.current || fallbackEstimates.current.size === 0) return;
    viewport.current?.setAttribute(TRANSCRIPT_RELEARN_ATTRIBUTE, '');
    relearnFrame.current = window.requestAnimationFrame(() => {
      relearnFrame.current = 0;
      viewport.current?.removeAttribute(TRANSCRIPT_RELEARN_ATTRIBUTE);
      const instance = virtualizerRefForEstimates.current;
      if (instance?.options.anchorTo !== 'end' || hasScrollGestureRef.current()) return;
      for (const key of fallbackEstimates.current) heldEstimates.current.delete(key);
      fallbackEstimates.current.clear();
      const core = instance as unknown as { pendingMin: number | null; itemSizeCacheVersion: number };
      core.pendingMin = 0;
      core.itemSizeCacheVersion += 1;
      coreScrollState(instance).notify(false);
      endPinForEstimates.current?.();
    });
  }, [hasScrollGestureRef, viewport]);
  const measureRowSize = useCallback(
    (element: Element, entry: ResizeObserverEntry | undefined, instance: TranscriptVirtualizer) => {
      const size = measureTranscriptRow(element, entry, instance);
      const row = entry ? rowsRef.current[instance.indexFromElement(element as HTMLDivElement)] : undefined;
      if (
        row &&
        timelineWidth.current > 0 &&
        row._tag !== 'Thinking' &&
        !('live' in row && row.live) &&
        !('active' in row && row.active) &&
        !element.querySelector('[data-transcript-pending]') &&
        element.getAttribute('data-disclosure-animating') !== 'true' &&
        !element.querySelector('[data-disclosure-animating="true"]') &&
        (size > 0 || element.firstElementChild?.getAttribute('data-blank') === 'true')
      ) {
        // What the observed box painted (TranscriptList.tsx data-variant), not
        // the current rows: a report can land between the paint and this
        // observation, and the line's height must not teach the hidden round.
        const variant = element.firstElementChild?.getAttribute('data-variant') ?? '';
        if (transcriptRowHeightStore().record(row, timelineWidth.current, size, surfaceRef.current, variant)) {
          relearnEstimates();
        }
      }
      return size;
    },
    [rowsRef, relearnEstimates, surfaceRef]
  );
  return {
    timelineWidth,
    virtualizerRefForEstimates,
    endPinForEstimates,
    heldEstimates,
    fallbackEstimates,
    relearnFrame,
    estimateRow,
    measureRowSize,
  };
}

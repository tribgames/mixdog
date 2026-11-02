import { type RefObject, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  foldTurnWork,
  submissionIdentity,
  type TranscriptRowModel,
  type TurnWorkSpan,
  turnWorkSpans,
} from './transcript-rows';

// Opened work folds by fold key: in memory only, kept across row remounts and
// session switches for this window's lifetime.
const OPEN_LIMIT = 200;
const openFolds = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function toggleWorkFold(key: string): void {
  if (openFolds.has(key)) openFolds.delete(key);
  else {
    openFolds.add(key);
    if (openFolds.size > OPEN_LIMIT) openFolds.delete(openFolds.values().next().value as string);
  }
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readVersion = () => version;

/** Keys of the rows the list paints in its visible range now (TranscriptList
 *  marks the overscan rows outside it data-offscreen). */
function rowKeysInView(viewport: HTMLElement | null): Set<string> {
  const keys = new Set<string>();
  for (const element of viewport?.querySelectorAll('.transcript-virtual-row:not([data-offscreen])') ?? []) {
    const key = element.getAttribute('data-timeline-key');
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * The rows with each finished multi-step turn's work folded above its final
 * answer (transcript-rows.ts turnWorkSpans). A turn the list already showed
 * unfolded folds at once while the view follows the bottom (the list's end
 * anchor keeps the answer where it is). A reader scrolled up with any of its
 * work rows in view keeps them until the view follows the bottom again or a
 * next message starts another turn; with none in view it folds at once, and
 * the list's reading anchor keeps what they read in place. A turn first seen
 * already finished (history, entry) folds at once.
 */
export function useTurnWorkFolds({
  rows,
  enabled,
  following,
  viewport,
}: {
  rows: readonly TranscriptRowModel[];
  enabled: boolean;
  following: boolean;
  viewport: RefObject<HTMLElement | null>;
}): readonly TranscriptRowModel[] {
  const openVersion = useSyncExternalStore(subscribe, readVersion, readVersion);
  const state = useRef({ seenRows: new Set<string>(), folding: new Set<string>(), held: new Set<string>() });
  // biome-ignore lint/correctness/useExhaustiveDependencies: openVersion re-reads the open folds.
  return useMemo(() => {
    if (!enabled) return rows;
    const { seenRows, folding, held } = state.current;
    const lastTurn = rows.at(-1)?.turnKey ?? '';
    let inView: Set<string> | null = null;
    const folds = (span: TurnWorkSpan) => {
      const open = openFolds.has(span.key);
      if (folding.has(span.key)) return { fold: true, open };
      // By row key: a turn's key changes when it ends (its attempt or
      // checkpoint), its rows' keys do not.
      const work = rows.slice(span.start, span.end + 1);
      const shownUnfolded = work.some((row) => seenRows.has(String(row.key)));
      const released = following || submissionIdentity(span.runKey) !== submissionIdentity(lastTurn);
      if (shownUnfolded && !released) {
        if (!held.has(span.key)) {
          inView ??= rowKeysInView(viewport.current);
          const keys = inView;
          if (work.some((row) => keys.has(String(row.key)))) held.add(span.key);
        }
        if (held.has(span.key)) return { fold: false, open };
      }
      held.delete(span.key);
      folding.add(span.key);
      return { fold: true, open };
    };
    const next = foldTurnWork(rows, turnWorkSpans(rows), folds);
    seenRows.clear();
    for (const row of rows) seenRows.add(String(row.key));
    return next;
  }, [rows, enabled, following, viewport, openVersion]);
}

import { useEffect, useMemo, useRef } from 'react';
import { defaultSessionLaneStore } from './session-lane-store';
import { requestSessionRead } from './session-read-request';
import { transcriptTurnKeys } from './renderer-logic.mjs';
import { transcriptRowHeightStore } from './transcript-row-estimates';
import { projectSettledTranscriptRows, type TranscriptRowModel } from './transcript-rows';
import { readTranscriptVirtualSnapshot, TRANSCRIPT_VIRTUAL_OVERSCAN } from './transcript-virtual-cache';
import { prefetchTurnChanges } from './turn-changes-model';
import { prefetchTurnReview } from './turn-review-prefetch';

/** The rows a session's first paint mounts when it follows its end: from the
 *  last row back until the viewport is covered, plus the list's overscan.
 *  Sizes are what the list will use (the session's remembered measurements,
 *  else the height store's estimate); the window bounds the pane (width: the
 *  widest it can be, so no narrower estimate mounts a row this leaves out). */
export function rowsMountedAtEnd(sessionId: string, rows: readonly TranscriptRowModel[]): TranscriptRowModel[] {
  const measured = new Map<unknown, number>();
  for (const item of readTranscriptVirtualSnapshot(sessionId)?.measurements ?? []) measured.set(item.key, item.size);
  const store = transcriptRowHeightStore();
  const mounted: TranscriptRowModel[] = [];
  let covered = 0;
  let overscan = 0;
  for (let index = rows.length - 1; index >= 0 && overscan < TRANSCRIPT_VIRTUAL_OVERSCAN; index -= 1) {
    const row = rows[index];
    mounted.push(row);
    if (covered >= window.innerHeight) overscan += 1;
    else covered += measured.get(row.key) ?? store.estimate(row, window.innerWidth, 'coding');
  }
  return mounted;
}

/** The reads the first commit of a session's rows would otherwise wait on
 *  (the mounted rows' changed-files cards, the island's entry review), started
 *  once its lane is held. They go through the shared reads and caches the
 *  mounted rows use (keyed by session, turn and epoch, and de-duplicated while
 *  in flight), so the render finds them and never repeats them, and a failed
 *  or outdated one is asked again by the next intent. */
function prepareSessionRows(sessionId: string): void {
  const lane = defaultSessionLaneStore.get(sessionId);
  const items = lane?.items;
  if (!lane || !Array.isArray(items) || items.length === 0) return;
  const turnKeys = transcriptTurnKeys(items) as string[];
  const { rows } = projectSettledTranscriptRows({
    sessionKey: sessionId,
    items,
    turnKeys,
    failedTurns: new Set(lane.failedTurnKeys || []),
  });
  for (const row of rowsMountedAtEnd(sessionId, rows)) {
    if ((row._tag === 'AssistantPart' || row._tag === 'Error') && row.turnChanges) {
      prefetchTurnChanges(sessionId, row.turnChanges.checkpointId, row.turnChanges.boundary);
    }
  }
  prefetchTurnReview(sessionId, items);
}

/** The one open intent in flight: its lane read, and, once that is
 *  acknowledged before the lane is delivered, the wait for the lane.
 *  `token` names this intent, so that a late finalize from an older press
 *  never touches a newer one. `confirmed`: the open itself happened, so the
 *  wait now belongs to it and runs to the lane's delivery. */
interface OpenIntent {
  token: number;
  sessionId: string;
  read: Promise<boolean>;
  ended: boolean;
  confirmed: boolean;
  stopWaiting: (() => void) | null;
}
let intent: OpenIntent | null = null;
let lastToken = 0;

function endIntent(ended: OpenIntent): void {
  ended.ended = true;
  ended.stopWaiting?.();
  ended.stopWaiting = null;
  if (intent === ended) intent = null;
}

/** The intent to open a session (press or focus on its row or tab): its lane
 *  read, then the content its first paint needs. The read is acknowledged a
 *  moment before the lane reaches the store, so the content waits for the lane
 *  itself: one wait per session, ended by the lane's delivery (even an empty
 *  one), the read failing, or the intent being finalized unopened. */
export function prepareSessionOpen(sessionId: string): Promise<boolean> {
  if (intent?.sessionId === sessionId && !intent.ended) return intent.read;
  if (intent) endIntent(intent);
  const read = requestSessionRead(sessionId);
  const current: OpenIntent = {
    token: ++lastToken,
    sessionId,
    read,
    ended: false,
    confirmed: false,
    stopWaiting: null,
  };
  intent = current;
  void read.then(
    (ready) => {
      if (current.ended) return;
      if (!ready) return endIntent(current);
      const deliver = () => {
        if (!defaultSessionLaneStore.get(sessionId)) return false;
        endIntent(current);
        prepareSessionRows(sessionId);
        return true;
      };
      if (!deliver()) current.stopWaiting = defaultSessionLaneStore.subscribe(sessionId, deliver);
    },
    () => endIntent(current)
  );
  return read;
}

/** The token of the live intent for a session, 0 when there is none. */
export function currentOpenToken(sessionId: string): number {
  return intent?.sessionId === sessionId && !intent.ended ? intent.token : 0;
}

/** The navigation to a session went ahead, synchronously in its handler: the
 *  intent that led to it keeps its wait until the lane is delivered. */
export function confirmSessionOpen(sessionId: string): void {
  if (intent?.sessionId === sessionId) intent.confirmed = true;
}

/** The handler that may have navigated is done: an intent it did not confirm
 *  was no open, so its wait ends. A token that is no longer current (a newer
 *  intent replaced it) does nothing. */
export function finalizeSessionOpen(token: number): void {
  if (token && intent?.token === token && !intent.confirmed) endIntent(intent);
}

/** Pointer and focus handlers that carry a session row's or tab's open
 *  intent, and `finalize` for the row's or tab's navigation handler (in a
 *  `finally`) and for its controls that do not navigate. A primary press or a
 *  focus starts the intent; a cancelled press, a pointer leaving while
 *  pressed, focus leaving the element, a context menu, a drag ending and the
 *  element going away finalize it. */
export function useSessionOpenIntent(sessionId: string, start: (sessionId: string) => unknown) {
  const token = useRef(0);
  const pressed = useRef(false);
  const startRef = useRef(start);
  startRef.current = start;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup reads the token this element's own intent holds when it goes away
  useEffect(() => () => finalizeSessionOpen(token.current), [sessionId]);
  return useMemo(() => {
    const begin = () => {
      if (!sessionId) return;
      startRef.current(sessionId);
      token.current = currentOpenToken(sessionId);
    };
    const finalize = () => {
      pressed.current = false;
      finalizeSessionOpen(token.current);
    };
    return {
      finalize,
      handlers: {
        onPointerDownCapture: (event: { button: number }) => {
          if (event.button !== 0) return;
          pressed.current = true;
          begin();
        },
        onFocusCapture: begin,
        onBlur: (event: { currentTarget: Element; relatedTarget: EventTarget | null }) => {
          // Pressing the row moves focus within it, and away from where it was.
          if (pressed.current || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          finalize();
        },
        onPointerUpCapture: () => {
          pressed.current = false;
        },
        onDragEnd: finalize,
        onPointerCancel: finalize,
        onPointerLeave: () => {
          if (pressed.current) finalize();
        },
      },
    };
  }, [sessionId]);
}

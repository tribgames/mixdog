import { type RefObject, useEffect, useRef } from 'react';
import type { TranscriptItem } from './desktop-types';
import { subscribeRemoteConnectionState } from './remote-connection-state';
import {
  cancelToolOutputPrefetch,
  historyPagePending,
  noteHistoryPagePending,
  prefetchToolOutputs,
  toolOutputCut,
} from './tool-full-output';

/** Scrolling has settled this long before rows near the screen are read. */
export const TOOL_OUTPUT_PREFETCH_IDLE_MS = 300;

interface Registered {
  sessionId: string;
  items: readonly TranscriptItem[];
}

/** Mounted tool groups holding rows with a cut output, by their element. */
const registered = new Map<HTMLElement, Registered>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
/** A finger is on the screen: nothing is read until it lifts and the list settles. */
let touching = false;

/** The cut rows of every registered group within about one screen of the
 *  viewport go to the read queue (tool-full-output.tsx: two at a time, none
 *  while a history page is pending). */
export function prefetchNearbyToolOutputs(): void {
  if (touching || historyPagePending()) return;
  const screen = window.innerHeight || 0;
  for (const [element, entry] of registered) {
    if (!element.isConnected) continue;
    const box = element.getBoundingClientRect();
    if (box.bottom < -screen || box.top > screen * 2) continue;
    prefetchToolOutputs(entry.sessionId, entry.items, element);
  }
}

function scheduleIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    prefetchNearbyToolOutputs();
  }, TOOL_OUTPUT_PREFETCH_IDLE_MS);
}

/** A scroll moves the reader on: reads queued for where they were are dropped
 *  and the idle wait restarts. */
function onScroll(): void {
  cancelToolOutputPrefetch();
  scheduleIdle();
}

/** A touch holds every read that has not started; the lift restarts the idle wait. */
function onTouchStart(): void {
  touching = true;
  cancelToolOutputPrefetch();
}

function onTouchEnd(): void {
  touching = false;
  scheduleIdle();
}

let stopConnection: (() => void) | null = null;

function listen(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  // Every scroll (the transcript's included: scroll events do not bubble, a
  // capturing listener sees them) restarts the idle wait; a link coming back
  // looks again.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
  stopConnection = subscribeRemoteConnectionState(scheduleIdle);
}

/** The last group left: no listener or timer stays behind. */
function stopListening(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  touching = false;
  if (!listening) return;
  listening = false;
  document.removeEventListener('scroll', onScroll, { capture: true });
  document.removeEventListener('touchstart', onTouchStart, { capture: true });
  document.removeEventListener('touchend', onTouchEnd, { capture: true });
  document.removeEventListener('touchcancel', onTouchEnd, { capture: true });
  stopConnection?.();
  stopConnection = null;
}

/** A history page request is on its way: background reads wait until the
 *  returned settle runs, then rows near the screen may be read. */
export function noteHistoryPageRequest(): () => void {
  noteHistoryPagePending(1);
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    noteHistoryPagePending(-1);
    if (registered.size) scheduleIdle();
  };
}

/** Registers a tool group's cut rows for idle prefetch while it is mounted;
 *  its queued reads are dropped when it leaves. */
export function useToolOutputPrefetch(
  ref: RefObject<HTMLElement | null>,
  sessionId: string,
  items: readonly TranscriptItem[]
): void {
  const cut = items.filter(toolOutputCut);
  const latest = useRef(cut);
  latest.current = cut;
  const any = cut.length > 0;
  useEffect(() => {
    const element = ref.current;
    if (!element || !any || !sessionId) return;
    registered.set(element, {
      sessionId,
      get items() {
        return latest.current;
      },
    });
    listen();
    scheduleIdle();
    return () => {
      registered.delete(element);
      cancelToolOutputPrefetch(element);
      if (!registered.size) stopListening();
    };
  }, [ref, any, sessionId]);
}

/** Test hook: forget every registration and pending idle wait. */
export function resetToolOutputPrefetch(): void {
  registered.clear();
  stopListening();
}

/** Diagnostics and tests: whether the scroll listener or an idle wait is live. */
export function toolOutputPrefetchListening(): boolean {
  return listening || idleTimer !== null;
}

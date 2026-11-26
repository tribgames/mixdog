// CloseWatcher (Android Chrome): one shared watcher for the active layer stack,
// history untouched: a pushState/back pair per open and close flashed the
// Android navigation bar white. Per HTML spec (PR #10168), one free ungrouped
// CloseWatcher is always allowed without transient user activation and
// destroy()/close() restores the free slot. Because at most one CloseWatcher
// exists at a time, two layers can never share a browser close-watcher group
// (a prompt veto always protects its parent).
// Browsers without CloseWatcher (and the Mixdog Android WebView, where
// MainActivity.java drives hardware Back through history.state.mixdogBack) use
// a stack of owned history sentinels (`sentinelStack`) tagged with a
// per-page-load nonce token so popping a multi-layer stack lands directly on
// the lower pre-pushed sentinel with zero pushState inside popstate (avoiding
// Chromium's History Manipulation Intervention). Programmatic closes NEVER
// call history.back(): shrinking updates mixdogBack in place, and reaching 0
// disarms the sentinel in place with mixdogBack omitted (undefined, never
// false). MainActivity.java sees undefined as 'none' and backgrounds the app;
// in regular browsers a real Back off disarmed/legacy sentinels forwards past
// them once to land directly on the prior page.
import { useEffect, useRef } from 'react';
import { nativeAppInfo } from '../shared/native-app';
import { useSurfaceActive } from './surface-activity';

export type MobileBackPriority = 'tab' | 'shell' | 'shell-sub' | 'overlay' | 'modal';
// biome-ignore lint/suspicious/noConfusingVoidType: handlers that return nothing must stay assignable; `undefined` alone rejects `() => void`.
export type MobileBackCloseHandler = () => boolean | void;

const PRIORITY_RANK: Record<MobileBackPriority, number> = {
  tab: 10,
  shell: 20,
  'shell-sub': 30,
  overlay: 40,
  modal: 50,
};

type CloseWatcherLike = { onclose: (() => void) | null; destroy(): void };
type CloseWatcherConstructor = new () => CloseWatcherLike;
type BackState = { mixdogBack?: unknown; mixdogBackToken?: unknown; mixdogBackSeq?: unknown };
type SentinelEntry = {
  token: string;
  seq: number | null;
  pushedInBoot: boolean;
  historyPos: number | null;
  href: string | null;
};

type BackEntry = {
  close: MobileBackCloseHandler;
  priority: number;
  released: boolean;
};

const HISTORY_ENTRY_CAP = 50;

let nonceCounter = 0;
function createBootNonce(): string {
  nonceCounter += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${nonceCounter}-${Math.random().toString(36).slice(2)}`;
}

const stack: BackEntry[] = [];
const tokenHistoryPos = new Map<string, number>();
let bootNonce = createBootNonce();
let nextTokenId = 0;
let nextSeq = 0;
let activeWatcher: CloseWatcherLike | null = null;
let sentinelStack: SentinelEntry[] = [];
let topHistoryLength: number | null = null;
let baseHistoryPos: number | null = null;
let hasForwardAfterSentinel = false;
let sawSubframeSinceArm = false;
let lastSentinelSeq: number | null = null;
let restoringSentinelToken: string | null = null;
let restoringTargetSeq: number | null = null;
let restoringStepsRemaining = 0;
let forwardingDisarmed = false;
let armedWindow: Window | null = null;
let popStateAttached = false;

function readToken(state: unknown): string | null {
  const token = (state as BackState | null)?.mixdogBackToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function readSeq(state: unknown): number | null {
  const seq = (state as BackState | null)?.mixdogBackSeq;
  return typeof seq === 'number' && Number.isInteger(seq) ? seq : null;
}

function observeSeq(seq: number | null): void {
  if (seq !== null && seq > nextSeq) {
    nextSeq = seq;
  }
}

function currentHref(): string | null {
  try {
    return typeof window !== 'undefined' && window.location ? window.location.href : null;
  } catch {
    return null;
  }
}

function createSentinelEntry(seq: number | null, pushedInBoot: boolean, historyPos: number | null): SentinelEntry {
  nextTokenId += 1;
  observeSeq(seq);
  return { token: `${bootNonce}:${nextTokenId}`, seq, pushedInBoot, historyPos, href: currentHref() };
}

function hasSubframe(): boolean {
  if (typeof window !== 'undefined' && window.frames && window.frames.length > 0) return true;
  if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
    return document.querySelector('iframe') !== null;
  }
  return false;
}

function hasAnySentinelMarker(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const backState = state as BackState;
  if (backState.mixdogBack || typeof backState.mixdogBack === 'number' || typeof backState.mixdogBack === 'boolean') {
    return true;
  }
  return readToken(backState) !== null || readSeq(backState) !== null;
}

function topSentinel(): SentinelEntry | null {
  return sentinelStack.length > 0 ? sentinelStack[sentinelStack.length - 1] : null;
}

function isOnTopSentinel(): boolean {
  const top = topSentinel();
  return top !== null && typeof history !== 'undefined' && readToken(history.state) === top.token;
}

function writeSentinelState(entry: SentinelEntry, armed: boolean): void {
  const state: BackState = { mixdogBackToken: entry.token };
  if (entry.seq !== null) {
    state.mixdogBackSeq = entry.seq;
  }
  if (armed) {
    state.mixdogBack = stack.length;
  }
  history.replaceState(state, '');
  entry.href = currentHref();
  lastSentinelSeq = entry.seq;
}

function clearRestoringState(): void {
  restoringSentinelToken = null;
  restoringTargetSeq = null;
  restoringStepsRemaining = 0;
}

function resetInternalState(): void {
  activeWatcher?.destroy();
  activeWatcher = null;
  stack.length = 0;
  tokenHistoryPos.clear();
  bootNonce = createBootNonce();
  nextTokenId = 0;
  nextSeq = 0;
  sentinelStack = [];
  topHistoryLength = null;
  baseHistoryPos = null;
  hasForwardAfterSentinel = false;
  sawSubframeSinceArm = false;
  lastSentinelSeq = null;
  clearRestoringState();
  forwardingDisarmed = false;
}

function adoptCurrentSentinel(armed: boolean, fallbackBelowSeq?: number | null): void {
  const existingToken = readToken(history.state);
  const existingPos = existingToken !== null ? (tokenHistoryPos.get(existingToken) ?? null) : null;
  const existingSeq = readSeq(history.state);
  const seq = existingSeq ?? (typeof fallbackBelowSeq === 'number' ? fallbackBelowSeq - 1 : null);
  const entry = createSentinelEntry(seq, false, existingPos);
  if (existingPos !== null) {
    tokenHistoryPos.set(entry.token, existingPos);
  }
  sentinelStack = [entry];
  writeSentinelState(entry, armed);
  topHistoryLength = history.length;
  sawSubframeSinceArm = hasSubframe();
}

function pushSentinel(): void {
  const beforeLen = history.length;
  const prevState = history.state as BackState | null;
  const wasNonSentinel = !hasAnySentinelMarker(prevState);
  const prevToken = readToken(prevState);
  const prevArmed = Boolean(prevState?.mixdogBack);
  nextSeq += 1;
  const entry = createSentinelEntry(nextSeq, true, null);
  sentinelStack.push(entry);
  history.pushState({ mixdogBack: stack.length, mixdogBackToken: entry.token, mixdogBackSeq: entry.seq }, '');
  const afterLen = history.length;
  if (beforeLen < HISTORY_ENTRY_CAP && afterLen <= HISTORY_ENTRY_CAP) {
    entry.historyPos = afterLen;
    tokenHistoryPos.set(entry.token, afterLen);
    if (wasNonSentinel) {
      baseHistoryPos = afterLen - 1;
    } else if (!prevArmed && prevToken !== null) {
      // If a disarmed sentinel (or an iframe entry sharing its parent state)
      // sits immediately below the newly pushed sentinel, record its exact
      // position `afterLen - 1` so veto restoration computes delta = +1
      // instead of overshooting with an older pre-iframe position.
      tokenHistoryPos.set(prevToken, afterLen - 1);
    }
  } else {
    // At the browser's 50-entry cap, eviction may shift earlier indices.
    tokenHistoryPos.clear();
    baseHistoryPos = null;
  }
  topHistoryLength = afterLen;
  hasForwardAfterSentinel = false;
  sawSubframeSinceArm = hasSubframe();
  lastSentinelSeq = entry.seq;
}

function startRestoreSentinel(
  priorSentinelStack: SentinelEntry[],
  target: SentinelEntry,
  landedToken: string | null
): void {
  sentinelStack = priorSentinelStack;
  restoringSentinelToken = target.token;
  restoringTargetSeq = target.seq;
  restoringStepsRemaining = Math.max(1, history.length);

  let delta = 1;
  if (target.historyPos !== null) {
    const landedPos = landedToken !== null ? (tokenHistoryPos.get(landedToken) ?? null) : baseHistoryPos;
    if (landedPos !== null && target.historyPos > landedPos) {
      delta = target.historyPos - landedPos;
    }
  }
  if (delta > 1 && typeof history.go === 'function') {
    history.go(delta);
  } else {
    history.forward();
  }
}

function reconcileSentinelStack(landed: string | null): boolean {
  if (landed !== null) {
    const idx = sentinelStack.findIndex((entry) => entry.token === landed);
    if (idx >= 0) {
      sentinelStack.length = idx + 1;
      topHistoryLength = history.length;
      return true;
    }
  }
  sentinelStack.length = 0;
  topHistoryLength = null;
  return false;
}

function adoptStaleSentinelIfPresent(): void {
  if (typeof history === 'undefined') return;
  if (!hasAnySentinelMarker(history.state)) return;
  // Adopt a pre-reload sentinel entry in place as a disarmed sentinel
  // (mixdogBack omitted/undefined, never false). Mark it as potentially having
  // stale forward entries so opening a layer in this boot pushes a fresh
  // sentinel and truncates them.
  adoptCurrentSentinel(false);
  hasForwardAfterSentinel = true;
}

function detachPopStateListener(): void {
  if (!armedWindow || !popStateAttached) return;
  try {
    armedWindow.removeEventListener('popstate', onPopState);
  } catch {
    /* ignore closed JSDOM windows */
  }
  popStateAttached = false;
}

function syncWindow(): void {
  if (typeof window === 'undefined' || typeof history === 'undefined') return;
  if (armedWindow !== window) {
    if (armedWindow) {
      // Only happens when a test swaps JSDOM windows: the previous window's
      // history and pending traversals are gone.
      detachPopStateListener();
      resetInternalState();
    }
    armedWindow = window;
  }
  // Non-native CloseWatcher browsers never touch window.history or attach a
  // popstate listener.
  if (closeWatcherConstructor() !== null) return;
  if (!popStateAttached) {
    window.addEventListener('popstate', onPopState);
    popStateAttached = true;
    adoptStaleSentinelIfPresent();
  }
}

/** Test-only helper simulating a fresh renderer load (new nonce, empty stack)
 *  while preserving whatever `window.history.state` the browser retained. */
export function __resetMobileBackForTest(): void {
  detachPopStateListener();
  armedWindow = null;
  resetInternalState();
  syncWindow();
}

function insertEntry(entry: BackEntry): void {
  let index = stack.length;
  while (index > 0 && stack[index - 1].priority > entry.priority) {
    index--;
  }
  stack.splice(index, 0, entry);
}

function armSentinel(): void {
  syncWindow();
  // Never let an unfinished restoration (e.g., stalled on an iframe entry)
  // permanently block newly opened layers from arming.
  if (restoringSentinelToken !== null) {
    clearRestoringState();
    sentinelStack.length = 0;
    topHistoryLength = null;
  }

  const subframeRisk = sawSubframeSinceArm || hasSubframe();

  // When growing above an already-armed parent sentinel (e.g., reopening a
  // child after Back), keep the lower sentinel(s) and push only the delta
  // ONLY when no iframe could have buried the parent in the vacated forward
  // slot (or silently at the 50-entry cap).
  const iframeCouldBuryTop = subframeRisk && (hasForwardAfterSentinel || history.length >= HISTORY_ENTRY_CAP);
  const canGrowFromTop =
    stack.length > sentinelStack.length &&
    topHistoryLength !== null &&
    history.length === topHistoryLength &&
    !iframeCouldBuryTop &&
    isOnTopSentinel();

  // Reuse an existing sentinel in place (replaceState with no pushState) ONLY
  // when no iframe could have navigated silently: unchanged history.length, no
  // forward entry, and no subframe present since arming (including at the
  // 50-entry cap when no iframe exists, avoiding evicting `/prev`).
  const canReuseInPlace =
    topHistoryLength !== null &&
    history.length === topHistoryLength &&
    !hasForwardAfterSentinel &&
    !subframeRisk &&
    isOnTopSentinel();

  if (!canGrowFromTop && !canReuseInPlace) {
    const canAdoptFresh =
      !hasForwardAfterSentinel && topHistoryLength === null && !subframeRisk && hasAnySentinelMarker(history.state);
    sentinelStack.length = 0;
    topHistoryLength = null;
    if (canAdoptFresh) {
      adoptCurrentSentinel(true);
    }
  }

  if (sentinelStack.length < stack.length) {
    while (sentinelStack.length < stack.length) {
      pushSentinel();
    }
    return;
  }

  const top = topSentinel();
  if (top && isOnTopSentinel()) {
    writeSentinelState(top, true);
  }
}

function armWatcher(Watcher: CloseWatcherConstructor): void {
  const watcher = new Watcher();
  activeWatcher = watcher;
  watcher.onclose = () => {
    if (activeWatcher !== watcher) return;
    activeWatcher = null;
    const top = stack.pop();
    if (top && top.close() === false && !top.released) {
      insertEntry(top);
    }
    if (stack.length > 0) {
      armForStack();
    }
  };
}

function armForStack(): void {
  if (stack.length === 0) return;
  if (activeWatcher !== null) return;
  const Watcher = closeWatcherConstructor();
  if (Watcher) {
    armWatcher(Watcher);
    return;
  }
  armSentinel();
}

function advanceRestoreSentinel(landed: string | null, landedSeq: number | null): boolean {
  if (landed === restoringSentinelToken) {
    clearRestoringState();
    topHistoryLength = history.length;
    const top = topSentinel();
    if (top && top.token === landed) {
      writeSentinelState(top, stack.length > 0);
    }
    return true;
  }
  const pastTarget = landedSeq !== null && restoringTargetSeq !== null && landedSeq > restoringTargetSeq;
  if (restoringStepsRemaining > 0) {
    restoringStepsRemaining -= 1;
    if (pastTarget) {
      history.back();
    } else {
      history.forward();
    }
    return true;
  }
  clearRestoringState();
  return false;
}

function handleForwardSentinel(landed: string | null, landedSeq: number): void {
  forwardingDisarmed = false;
  if (stack.length === 0) {
    adoptCurrentSentinel(false);
    return;
  }
  const existingPos = landed !== null ? (tokenHistoryPos.get(landed) ?? null) : null;
  const entry = createSentinelEntry(landedSeq, false, existingPos);
  if (existingPos !== null) {
    tokenHistoryPos.set(entry.token, existingPos);
  }
  sentinelStack.push(entry);
  writeSentinelState(entry, true);
  topHistoryLength = history.length;
}

function continueForwardingDisarmed(landed: string | null, landedSeq: number | null, previousSeq: number | null): void {
  if (stack.length > 0) {
    forwardingDisarmed = false;
    reconcileSentinelStack(landed);
    armForStack();
    return;
  }
  if (hasAnySentinelMarker(history.state)) {
    if (landedSeq === null) {
      if (previousSeq === null) {
        // Unknown direction between sequenceless legacy entries: stop here.
        forwardingDisarmed = false;
        adoptCurrentSentinel(false);
        return;
      }
      // Stamp a strictly decreasing seq onto this sequenceless legacy entry
      // before stepping further back so if index 0 stops `history.back()`,
      // any later Forward onto a stamped entry has landedSeq > previousSeq.
      const stamped = createSentinelEntry(previousSeq - 1, false, null);
      writeSentinelState(stamped, false);
      history.back();
      return;
    }
    if (previousSeq !== null && landedSeq >= previousSeq) {
      forwardingDisarmed = false;
      adoptCurrentSentinel(false);
      return;
    }
    lastSentinelSeq = landedSeq;
    history.back();
    return;
  }
  forwardingDisarmed = false;
  sentinelStack.length = 0;
  topHistoryLength = null;
  lastSentinelSeq = null;
  history.back();
}

function handleArmedBackPop(priorSentinelStack: SentinelEntry[], wasTop: SentinelEntry, landed: string | null): void {
  // Remove the entry FIRST so the owner's cleanup (unregister) sees it gone.
  const top = stack.pop();
  const vetoed = Boolean(top && top.close() === false && !top.released);
  if (vetoed && top) {
    insertEntry(top);
  }
  if (activeWatcher !== null) return;
  if (vetoed) {
    // Restore the exact popped sentinel via history.go(delta)/forward() so
    // vetoed Back presses perform zero pushState calls inside popstate and
    // jump atomically over any intermediate iframe or sentinel entries.
    startRestoreSentinel(priorSentinelStack, wasTop, landed);
    return;
  }
  if (stack.length > 0) {
    // Keep sentinelStack aligned with the active layers so reopening a
    // child pushes only the delta (1 entry) instead of rebuilding lower layers.
    if (sentinelStack.length > stack.length) {
      sentinelStack = sentinelStack.slice(-stack.length);
    }
    const current = topSentinel();
    if (current && isOnTopSentinel()) {
      // Landed directly on a pre-pushed lower sentinel: update in place
      // with zero pushState inside popstate.
      writeSentinelState(current, true);
    } else if (hasAnySentinelMarker(history.state)) {
      adoptCurrentSentinel(true, wasTop.seq);
    } else {
      // No lower sentinel beneath wasTop (e.g. a second layer opened
      // during an earlier veto): step forward onto wasTop instead of
      // calling pushState inside popstate.
      startRestoreSentinel(priorSentinelStack, wasTop, landed);
    }
    return;
  }
  const current = topSentinel();
  if (current && isOnTopSentinel()) {
    // Closed the last open layer while landing on a spare owned sentinel:
    // disarm in place with mixdogBack omitted.
    sentinelStack = [current];
    writeSentinelState(current, false);
  } else if (hasAnySentinelMarker(history.state)) {
    // Landed on a lower prior-boot/legacy sentinel after closing the last
    // layer: preserve its seq (or assign strictly below wasTop.seq for
    // legacy) so a subsequent Forward onto wasTop is never mistaken for Back.
    adoptCurrentSentinel(false, wasTop.seq);
  } else {
    lastSentinelSeq = null;
  }
}

function handleDisarmedBackPop(
  wasTop: SentinelEntry,
  landedSeq: number | null,
  previousSeq: number | null,
  priorTopHistoryLength: number | null
): void {
  if (hasAnySentinelMarker(history.state)) {
    // A sequenceless legacy entry is proven behind us ONLY when stepping
    // directly off a sentinel pushed in this boot (which truncated forward
    // history). Once on a prior-boot legacy entry, direction is unknown.
    const provenBehind = wasTop.pushedInBoot || (landedSeq !== null && previousSeq !== null && landedSeq < previousSeq);
    if (!provenBehind) {
      adoptCurrentSentinel(false);
      return;
    }
    // Another sentinel strictly behind us lies below: stamp sequenceless
    // legacy entries with a strictly decreasing seq so hitting index 0 at
    // the cap can never misclassify a later Forward as Back.
    forwardingDisarmed = true;
    sentinelStack.length = 0;
    topHistoryLength = null;
    if (landedSeq === null && previousSeq !== null) {
      const stamped = createSentinelEntry(previousSeq - 1, false, null);
      writeSentinelState(stamped, false);
    } else {
      lastSentinelSeq = landedSeq ?? (previousSeq !== null ? previousSeq - 1 : null);
    }
    history.back();
    return;
  }
  // Unmarked state (e.g. `/app` or a fragment navigation like `/app#details`):
  // only forward Back to `/previous` when this was a real Back traversal onto
  // the same URL, never when a fragment link grew history or changed URL/hash.
  const grewHistory = priorTopHistoryLength !== null && history.length > priorTopHistoryLength;
  const hrefNow = currentHref();
  const urlChanged = wasTop.href !== null && hrefNow !== null && hrefNow !== wasTop.href;
  sentinelStack.length = 0;
  topHistoryLength = null;
  lastSentinelSeq = null;
  if (grewHistory || urlChanged) {
    return;
  }
  history.back();
}

function onPopState(): void {
  // Watcher layers answer to their own close event, never to history.
  if (activeWatcher !== null || closeWatcherConstructor() !== null) return;

  hasForwardAfterSentinel = true;
  if (hasSubframe()) {
    sawSubframeSinceArm = true;
  }
  const landed = readToken(history.state);
  const landedSeq = readSeq(history.state);
  observeSeq(landedSeq);

  if (restoringSentinelToken !== null && advanceRestoreSentinel(landed, landedSeq)) {
    return;
  }

  const wasTop = topSentinel();
  const previousSeq = wasTop?.seq ?? lastSentinelSeq;

  // Always evaluate Forward detection BEFORE `forwardingDisarmed` or
  // disarmed-Back logic so a higher finite seq immediately clears any
  // stuck `forwardingDisarmed` and stays at the user-selected entry.
  if (landedSeq !== null && previousSeq !== null && landedSeq > previousSeq) {
    handleForwardSentinel(landed, landedSeq);
    return;
  }

  if (forwardingDisarmed) {
    continueForwardingDisarmed(landed, landedSeq, previousSeq);
    return;
  }

  // Ignore a popstate that landed back ON our own top sentinel, updating its
  // armed/disarmed state if stack depth changed while navigation was in flight.
  if (wasTop !== null && landed === wasTop.token) {
    topHistoryLength = history.length;
    writeSentinelState(wasTop, stack.length > 0);
    return;
  }

  if (wasTop !== null) {
    const priorSentinelStack = sentinelStack.slice();
    const priorTopHistoryLength = topHistoryLength;
    reconcileSentinelStack(landed);
    if (stack.length > 0) {
      handleArmedBackPop(priorSentinelStack, wasTop, landed);
    } else {
      handleDisarmedBackPop(wasTop, landedSeq, previousSeq, priorTopHistoryLength);
    }
    return;
  }

  // User pressed Forward onto a previously popped sentinel entry while no
  // layer is open: adopt it as a disarmed sentinel (preserving seq)
  // so another Forward is recognized as Forward and Back forwards to `/previous`.
  if (stack.length === 0 && hasAnySentinelMarker(history.state)) {
    adoptCurrentSentinel(false);
  }
}

function mobileBackSurface(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.hasAttribute('data-mixdog-mobile-tabs') &&
    typeof history !== 'undefined'
  );
}

function closeWatcherConstructor(): CloseWatcherConstructor | null {
  // Inside the Mixdog phone app the Android WebView exposes CloseWatcher but
  // never routes the hardware back to it; the app's back handler pops the
  // history sentinel instead.
  if (nativeAppInfo()) return null;
  const ctor = (window as unknown as { CloseWatcher?: CloseWatcherConstructor }).CloseWatcher;
  return typeof ctor === 'function' ? ctor : null;
}

function disarmSentinelOnEmptyStack(): void {
  const top = topSentinel();
  if (top && isOnTopSentinel()) {
    // Disarm in place (mixdogBack omitted/undefined, never false) with zero
    // programmatic history.back(). If an iframe changed history.length while
    // armed, mint a fresh disarmed token recorded at current history.length
    // (while leaving topHistoryLength unchanged so the next open pushes above
    // the iframe instead of reusing in place).
    if (topHistoryLength !== null && history.length !== topHistoryLength) {
      const pos = history.length < HISTORY_ENTRY_CAP && !hasForwardAfterSentinel ? history.length : null;
      const disarmed = createSentinelEntry(top.seq, top.pushedInBoot, pos);
      if (pos !== null) {
        tokenHistoryPos.set(disarmed.token, pos);
      }
      sentinelStack = [disarmed];
      writeSentinelState(disarmed, false);
    } else {
      writeSentinelState(top, false);
    }
  } else if (typeof history !== 'undefined' && hasAnySentinelMarker(history.state)) {
    // Stack reached 0 while sitting on a non-top sentinel (e.g., after a
    // stalled veto restoration): always disarm history.state so mixdogBack
    // is never left armed with zero open layers.
    adoptCurrentSentinel(false);
    hasForwardAfterSentinel = true;
  } else {
    sentinelStack.length = 0;
    topHistoryLength = null;
  }
}

/** Register an open transient layer; returns its unregister cleanup.
 *  Returning `false` from `close` vetoes dismissal and keeps the layer armed. */
export function registerMobileBack(
  close: MobileBackCloseHandler,
  priority: MobileBackPriority = 'overlay'
): () => void {
  if (!mobileBackSurface()) return () => {};
  syncWindow();
  forwardingDisarmed = false;
  const entry: BackEntry = {
    close,
    priority: PRIORITY_RANK[priority],
    released: false,
  };
  insertEntry(entry);
  armForStack();
  return () => {
    entry.released = true;
    const index = stack.indexOf(entry);
    if (index < 0) return; // already consumed by the back button
    stack.splice(index, 1);
    if (hasSubframe()) {
      sawSubframeSinceArm = true;
    }
    if (restoringSentinelToken !== null) {
      clearRestoringState();
    }
    if (stack.length > 0) {
      const top = topSentinel();
      if (activeWatcher === null && top && isOnTopSentinel()) {
        writeSentinelState(top, true);
      }
      return;
    }
    if (activeWatcher !== null) {
      activeWatcher.destroy();
      activeWatcher = null;
      return;
    }
    disarmSentinelOnEmptyStack();
  };
}

/** Arms the sentinel for as long as `open` stays true.
 *
 *  Every transient layer in the renderer registers through this hook; higher
 *  priority tiers close first, and layers within the same tier close LIFO.
 *  Returning `false` from `close` keeps the layer armed (for busy/blocked
 *  dialogs). The close callback is read through a ref: a re-render must never
 *  re-push history, only the open transition may. */
export function useMobileBack(
  open: boolean,
  close: MobileBackCloseHandler,
  priority: MobileBackPriority = 'overlay'
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  // A layer inside a retained or parked surface (an off-screen conversation,
  // an inactive Dock tab) is not on top of anything the user sees: Back
  // belongs to the shown surface until this one is shown again.
  const surfaceActive = useSurfaceActive();
  const armed = open && surfaceActive;
  useEffect(() => {
    if (!armed) return undefined;
    return registerMobileBack(() => closeRef.current(), priority);
  }, [armed, priority]);
}

syncWindow();

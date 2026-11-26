import { useCallback, useSyncExternalStore } from 'react';

import {
  type DesktopVisualizeEvent,
  type VisualizeCommandResult,
  type VisualizeInlineContent,
  type VisualizeSessionState,
  type VisualizeTabView,
  VISUALIZE_PANELS_EVENT,
  visualizeThumbnail,
} from '../shared/visualize';
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { uiFormatLocale } from './i18n';
import { registerIdleReclaim } from './idle-reclaim';
import { linkOpenTarget } from './link-open-target';
import { isMobileRemoteSurface } from './mobile-surface';
import { enforceRendererCacheBudget, registerBudgetedCache } from './renderer-cache-budget';
import { estimateRetainedChars } from './renderer-value-weight';
import { useSurfaceActive } from './surface-activity';
import { timeFormatOptions } from './time-format-preference';
import { livePanes, releaseVisualizeSessionCards, sameTarget } from './visualize-card-model';
import { pruneVisualizeProposals, releaseVisualizeProposals } from './visualize-feedback-gate';
import { pruneVisualizeTweaks, releaseVisualizeTweaks } from './visualize-tweaks-store';
import { emitVisualizeZoomInput, emitVisualizeZoomModifier } from './visualize-zoom';

type Listener = () => void;
type RevealListener = (sessionId: string) => void;

const EMPTY: VisualizeSessionState = Object.freeze({ sessionId: '', tabs: [], active: null });

interface EvictedSessionEntry {
  active: string | null;
  versions: Map<string, number>;
  placeholder: VisualizeSessionState;
  failed: boolean;
  retries: number;
}

const RECENT_READER_LRU_MAX = 4;
const REHYDRATE_RETRY_DELAY_MS = 1_500;
const REHYDRATE_MAX_RETRIES = 2;

/** What each session shows. While an agent turn runs that is the result of
 *  the last turn that ended: main keeps the running turn's work until its end. */
let states = new Map<string, VisualizeSessionState>();
/** Active hook readers per session (visible surfaces only); pinned along with `onScreen`. */
const sessionReaders = new Map<string, number>();
/** Bounded LRU of sessions recently read by a visible `useVisualizeState` hook;
 *  retained across transient `<Activity mode="hidden">` unmounts to prevent eviction flicker. */
const recentReaderSessions = new Set<string>();
/** Sessions dropped from `states` while off screen (budget or idle reclaim), with their last known tab versions. */
const evictedSessions = new Map<string, EvictedSessionEntry>();
/** Sessions with missed updates from a reconnect resync, pinned until their deferred reveal runs. */
const pendingResyncPins = new Map<string, number>();
const resyncTimers = new Set<ReturnType<typeof setTimeout>>();
const stateWeights = new WeakMap<VisualizeSessionState, number>();
let retainedStateChars = 0;
let rehydrateInFlight: Promise<void> | null = null;
let rehydrateRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** The sessions with a turn whose work main keeps back (`held` events and
 *  snapshots), each with when the oldest turn not shown yet started (ms; 0
 *  when the host did not say). */
const heldSince = new Map<string, number>();
/** Tool call ids held by the running turn(s) of each held session. */
const heldCalls = new Map<string, ReadonlySet<string>>();

function setHeldCallsFor(sessionId: string, calls: readonly string[] | undefined): void {
  const clean = Array.isArray(calls) ? calls.filter((id) => typeof id === 'string' && id.length > 0) : [];
  if (clean.length === 0) {
    heldCalls.delete(sessionId);
    return;
  }
  const current = heldCalls.get(sessionId);
  if (current && current.size === clean.length && clean.every((id) => current.has(id))) return;
  heldCalls.set(sessionId, new Set(clean));
}
const listeners = new Set<Listener>();
const revealListeners = new Set<RevealListener>();
const emptiedListeners = new Set<RevealListener>();
/** Reveals asked for before the app shell subscribed (a reloaded renderer
 *  hydrates before its effects run); delivered to the first listener. */
const pendingReveals = new Set<string>();
let connected = false;

const PANEL_MEMORY_KEY = 'mixdog.visualize.panels.v1';

/** Sessions whose visualize panel is on screen right now (VisualizePane). */
const onScreen = new Set<string>();
/** The tab the user picked in a session's panel (strip, chat card). */
const userPicks = new Map<string, string>();
/** A user's request to open a closed tab or history entry, per session: the
 *  reveal of a tab that is exactly its target (within USER_OPEN_TTL_MS)
 *  shows the panel, on the phone too, once. */
interface UserOpen {
  matches: (tab: VisualizeTabView) => boolean;
  expires: number;
  /** A turn preview opened behind the agent's own opens: made or updated,
   *  never shown over them. */
  silent?: boolean;
}
const userOpens = new Map<string, UserOpen>();
const USER_OPEN_TTL_MS = 15_000;
/** A turn's end opening its previews (openTurnPreviews), one entry per open
 *  request: when main's open of exactly that tab arrives, a panel the user
 *  keeps closed at that moment stays closed (the tab is only made or updated). */
const previewOpens = new Map<string, UserOpen[]>();
/** Tabs opened or updated behind the user's pick, per session. */
let updatedTabs = new Map<string, ReadonlySet<string>>();
const NO_UPDATES: ReadonlySet<string> = new Set();
interface PanelMemory {
  open: Set<string>;
  closed: Set<string>;
}
let panelMemoryCache: PanelMemory | null = null;

function panelMemory(): PanelMemory {
  if (panelMemoryCache) return panelMemoryCache;
  let open: string[] = [];
  let closed: string[] = [];
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(PANEL_MEMORY_KEY) ?? '{}');
    if (Array.isArray(parsed?.open)) open = parsed.open.map(String);
    if (Array.isArray(parsed?.closed)) closed = parsed.closed.map(String);
  } catch {
    // Unreadable memory starts empty.
  }
  panelMemoryCache = { open: new Set(open), closed: new Set(closed) };
  return panelMemoryCache;
}

function savePanelMemory(): void {
  const memory = panelMemory();
  try {
    globalThis.localStorage?.setItem(
      PANEL_MEMORY_KEY,
      JSON.stringify({ open: [...memory.open], closed: [...memory.closed] })
    );
  } catch {
    // Best-effort: the in-memory sets still apply for this renderer.
  }
}

const VISUALIZE_STATE_MEASURE_LIMIT = 64 * 1024 * 1024;

function stateChars(state: VisualizeSessionState): number {
  let chars = stateWeights.get(state);
  if (chars === undefined) {
    chars = estimateRetainedChars(state, VISUALIZE_STATE_MEASURE_LIMIT);
    stateWeights.set(state, chars);
  }
  return chars;
}

function evictedPlaceholderFor(state: VisualizeSessionState): VisualizeSessionState {
  return Object.freeze({
    sessionId: state.sessionId,
    tabs: [],
    active: null,
    ...(state.goneOpens?.length ? { goneOpens: state.goneOpens } : {}),
  });
}

function touchRecentReader(sessionId: string): void {
  if (!sessionId || (!states.has(sessionId) && !evictedSessions.has(sessionId))) return;
  recentReaderSessions.delete(sessionId);
  recentReaderSessions.add(sessionId);
  while (recentReaderSessions.size > RECENT_READER_LRU_MAX) {
    const oldest = recentReaderSessions.values().next().value;
    if (oldest === undefined) break;
    recentReaderSessions.delete(oldest);
  }
}

function clearRehydrateRetryTimer(): void {
  if (rehydrateRetryTimer !== null) {
    clearTimeout(rehydrateRetryTimer);
    rehydrateRetryTimer = null;
  }
}

function clearResyncTimers(): void {
  for (const timer of resyncTimers) clearTimeout(timer);
  resyncTimers.clear();
}

function releaseResyncPin(sessionId: string): void {
  const remaining = (pendingResyncPins.get(sessionId) ?? 0) - 1;
  if (remaining > 0) pendingResyncPins.set(sessionId, remaining);
  else pendingResyncPins.delete(sessionId);
}

function notifyEmptied(sessionId: string): void {
  for (const listener of emptiedListeners) listener(sessionId);
}

function pruneSessionPaneState(sessionId: string, state: VisualizeSessionState | undefined): void {
  const tabs = state?.tabs ?? [];
  pruneVisualizeTweaks(sessionId, tabs);
  pruneVisualizeProposals(sessionId, tabs);
}

function isActiveSession(sessionId: string): boolean {
  return onScreen.has(sessionId) || (sessionReaders.get(sessionId) ?? 0) > 0;
}

function isPinnedSession(sessionId: string): boolean {
  return (
    isActiveSession(sessionId) || recentReaderSessions.has(sessionId) || (pendingResyncPins.get(sessionId) ?? 0) > 0
  );
}

function setStatesMap(next: Map<string, VisualizeSessionState>): void {
  states = next;
  let total = 0;
  for (const [id, state] of states) {
    evictedSessions.delete(id);
    total += stateChars(state);
  }
  retainedStateChars = total;
}

function touchState(sessionId: string): void {
  const current = states.get(sessionId);
  if (!current) return;
  states.delete(sessionId);
  states.set(sessionId, current);
}

function pinnedStateChars(): number {
  let total = 0;
  for (const [id, state] of states) {
    if (isPinnedSession(id)) total += stateChars(state);
  }
  return total;
}

function evictUnpinnedStates(targetChars: number): void {
  if (retainedStateChars <= targetChars) return;
  let next: Map<string, VisualizeSessionState> | null = null;
  for (const [sessionId, state] of states) {
    if (retainedStateChars <= targetChars) break;
    if (isPinnedSession(sessionId)) continue;
    next ??= new Map(states);
    next.delete(sessionId);
    evictedSessions.set(sessionId, {
      active: state.active,
      versions: tabVersions(state),
      placeholder: evictedPlaceholderFor(state),
      failed: false,
      retries: 0,
    });
    retainedStateChars -= stateChars(state);
  }
  if (!next) return;
  states = next;
  emit();
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

function clearRehydrateRetryIfIdle(): void {
  if (![...evictedSessions.values()].some((entry) => entry.failed && entry.retries <= REHYDRATE_MAX_RETRIES)) {
    clearRehydrateRetryTimer();
  }
}

function rehydrateIfActiveEvicted(): void {
  if ([...evictedSessions.entries()].some(([id, entry]) => isActiveSession(id) && !entry.failed)) {
    rehydrateEvicted();
  }
}

function scheduleRehydrateRetry(): void {
  if (rehydrateRetryTimer !== null) return;
  rehydrateRetryTimer = setTimeout(() => {
    rehydrateRetryTimer = null;
    let cleared = false;
    let retryActive = false;
    for (const [sessionId, entry] of evictedSessions) {
      if (entry.failed && entry.retries <= REHYDRATE_MAX_RETRIES) {
        entry.failed = false;
        cleared = true;
        if (isActiveSession(sessionId)) retryActive = true;
      }
    }
    if (cleared) emit();
    if (retryActive) rehydrateEvicted();
  }, REHYDRATE_RETRY_DELAY_MS);
  unrefTimer(rehydrateRetryTimer);
}

function failRehydrate(targets: ReadonlyArray<readonly [string, EvictedSessionEntry]>): void {
  let shouldRetry = false;
  let updated = false;
  for (const [sessionId, entry] of targets) {
    if (evictedSessions.get(sessionId) !== entry) continue;
    entry.retries += 1;
    entry.failed = true;
    updated = true;
    if (entry.retries <= REHYDRATE_MAX_RETRIES) {
      shouldRetry = true;
    }
  }
  if (updated) emit();
  if (shouldRetry) scheduleRehydrateRetry();
  rehydrateIfActiveEvicted();
}

function applyHeldFromRaw(sessionId: string, raw: VisualizeSessionState): VisualizeSessionState {
  const { held, heldSince: since, heldCalls: calls, ...state } = raw;
  // Also of a session that shows nothing yet: its running turn's cards wait all the same.
  if (held === true) {
    heldSince.set(sessionId, Number.isFinite(since) ? Number(since) : 0);
    setHeldCallsFor(sessionId, calls);
  } else {
    heldSince.delete(sessionId);
    heldCalls.delete(sessionId);
  }
  return state;
}

function applyRehydratedSnapshot(
  targets: ReadonlyArray<readonly [string, EvictedSessionEntry]>,
  snapshot: readonly VisualizeSessionState[]
): void {
  const byId = new Map<string, VisualizeSessionState>();
  for (const raw of snapshot) {
    if (raw?.sessionId) byId.set(raw.sessionId, raw);
  }
  const beforeHolds = holdKey();
  const next = new Map(states);
  let statesChanged = false;
  let clearedEvicted = false;
  const emptied: string[] = [];
  for (const [sessionId, entry] of targets) {
    if (evictedSessions.get(sessionId) !== entry || entry.failed) continue;
    const raw = byId.get(sessionId);
    if (!raw?.tabs.length) {
      evictedSessions.delete(sessionId);
      clearedEvicted = true;
      pruneSessionPaneState(sessionId, undefined);
      if (entry.versions.size > 0) emptied.push(sessionId);
      if (raw) {
        const state = applyHeldFromRaw(sessionId, raw);
        if (state.history?.length) statesChanged = putState(next, state) || statesChanged;
        else recentReaderSessions.delete(sessionId);
      } else {
        recentReaderSessions.delete(sessionId);
        heldSince.delete(sessionId);
        heldCalls.delete(sessionId);
      }
      continue;
    }
    pruneSessionPaneState(sessionId, raw);
    if (!isActiveSession(sessionId)) continue;
    evictedSessions.delete(sessionId);
    const state = keptLocalActive(applyHeldFromRaw(sessionId, raw), entry.active);
    statesChanged = putState(next, state) || statesChanged;
    clearedEvicted = true;
  }
  const holdsChanged = holdKey() !== beforeHolds;
  if (statesChanged) {
    setStatesMap(next);
    emit();
  } else if (holdsChanged || clearedEvicted) {
    emit();
  }
  for (const sessionId of emptied) notifyEmptied(sessionId);
  if (statesChanged) enforceRendererCacheBudget();
  clearRehydrateRetryIfIdle();
  rehydrateIfActiveEvicted();
}

function rehydrateEvicted(): void {
  if (rehydrateInFlight || !evictedSessions.size) return;
  const targets: Array<readonly [string, EvictedSessionEntry]> = [];
  for (const [sessionId, entry] of evictedSessions) {
    if (isActiveSession(sessionId) && !entry.failed) targets.push([sessionId, entry]);
  }
  if (!targets.length) return;
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  if (!api?.visualizeState) {
    const emptied: string[] = [];
    for (const [sessionId, entry] of targets) {
      if (evictedSessions.get(sessionId) !== entry) continue;
      evictedSessions.delete(sessionId);
      recentReaderSessions.delete(sessionId);
      pruneSessionPaneState(sessionId, undefined);
      if (entry.versions.size > 0) emptied.push(sessionId);
    }
    if (!evictedSessions.size) clearRehydrateRetryTimer();
    emit();
    for (const sessionId of emptied) notifyEmptied(sessionId);
    return;
  }
  const read = api.visualizeState;
  const request = Promise.resolve()
    .then(() => read())
    .then((snapshot) => {
      if (rehydrateInFlight === request) rehydrateInFlight = null;
      if (!snapshot) {
        failRehydrate(targets);
        return;
      }
      applyRehydratedSnapshot(targets, snapshot);
    })
    .catch(() => {
      if (rehydrateInFlight === request) rehydrateInFlight = null;
      failRehydrate(targets);
    });
  rehydrateInFlight = request;
}

registerBudgetedCache({
  name: 'visualize-states',
  chars: () => retainedStateChars,
  pinned: pinnedStateChars,
  trim: evictUnpinnedStates,
});
registerIdleReclaim(() => evictUnpinnedStates(0));

/** Test seam: forget the in-memory panel memory so storage is re-read. */
export function resetVisualizePanelMemory(): void {
  panelMemoryCache = null;
  onScreen.clear();
  recentReaderSessions.clear();
  evictedSessions.clear();
  pendingResyncPins.clear();
  clearResyncTimers();
  rehydrateInFlight = null;
  clearRehydrateRetryTimer();
  userPicks.clear();
  userOpens.clear();
  previewOpens.clear();
  updatedTabs = new Map();
  heldSince.clear();
  heldCalls.clear();
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** A session was deleted: everything the visualize panel holds for it goes. */
export function releaseVisualizeSession(sessionId: string): void {
  setVisualizePanelOnScreen(sessionId, false);
  recentReaderSessions.delete(sessionId);
  pendingResyncPins.delete(sessionId);
  const hadEvicted = evictedSessions.delete(sessionId);
  if (!evictedSessions.size) clearRehydrateRetryTimer();
  userPicks.delete(sessionId);
  userOpens.delete(sessionId);
  previewOpens.delete(sessionId);
  heldSince.delete(sessionId);
  heldCalls.delete(sessionId);
  pendingReveals.delete(sessionId);
  if (updatedTabs.has(sessionId)) {
    updatedTabs = new Map(updatedTabs);
    updatedTabs.delete(sessionId);
  }
  const memory = panelMemory();
  if (memory.open.delete(sessionId) || memory.closed.delete(sessionId)) savePanelMemory();
  if (states.has(sessionId)) {
    const next = new Map(states);
    next.delete(sessionId);
    replaceStates(next);
  } else if (hadEvicted) {
    emit();
  }
  releaseVisualizeTweaks(sessionId);
  releaseVisualizeProposals(sessionId);
  releaseVisualizeSessionCards(sessionId);
}

function requestReveal(sessionId: string): void {
  if (!revealListeners.size) {
    pendingReveals.add(sessionId);
    return;
  }
  for (const listener of revealListeners) listener(sessionId);
}

/** `next` with every part equal to the same part of `prev` replaced by
 *  `prev`'s own object, so unchanged data keeps its identity (and `prev`
 *  itself comes back when nothing differs). Plain JSON data only. */
function shareStructure<T>(prev: unknown, next: T): T {
  if (prev === next || !prev || !next || typeof prev !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    const items = next.map((item, index) => shareStructure(prev[index], item));
    return (items.length === prev.length && items.every((item, index) => item === prev[index]) ? prev : items) as T;
  }
  if (Array.isArray(prev)) return next;
  const before = prev as Record<string, unknown>;
  const keys = Object.keys(next);
  const shared: Record<string, unknown> = {};
  for (const key of keys) shared[key] = shareStructure(before[key], (next as Record<string, unknown>)[key]);
  const same =
    keys.length === Object.keys(before).length && keys.every((key) => key in before && shared[key] === before[key]);
  return (same ? prev : shared) as T;
}

/** `state` sharing everything unchanged with `prev`; tabs are matched by id,
 *  so a reorder or an insert keeps the other tabs' objects. */
function shareSession(prev: VisualizeSessionState | undefined, state: VisualizeSessionState): VisualizeSessionState {
  if (!prev) return state;
  const prevTabs = new Map(prev.tabs.map((tab) => [tab.id, tab]));
  const tabs = state.tabs.map((tab) => shareStructure(prevTabs.get(tab.id), tab));
  const sameTabs = tabs.length === prev.tabs.length && tabs.every((tab, index) => tab === prev.tabs[index]);
  const shared: Record<string, unknown> = { tabs: sameTabs ? prev.tabs : tabs };
  const before = prev as unknown as Record<string, unknown>;
  const keys = Object.keys(state).filter((key) => key !== 'tabs');
  for (const key of keys) shared[key] = shareStructure(before[key], (state as unknown as Record<string, unknown>)[key]);
  const same =
    sameTabs &&
    keys.length === Object.keys(before).filter((key) => key !== 'tabs').length &&
    keys.every((key) => key in before && shared[key] === before[key]);
  return (same ? prev : shared) as unknown as VisualizeSessionState;
}

/** Put `state` into `map`; false when it changes nothing. A session with
 *  nothing open keeps its "All visuals" list. */
function putState(map: Map<string, VisualizeSessionState>, state: VisualizeSessionState): boolean {
  const prev = map.get(state.sessionId);
  if (!(state.tabs.length || state.history?.length)) {
    const removedEvicted = evictedSessions.delete(state.sessionId);
    if (removedEvicted && !evictedSessions.size) clearRehydrateRetryTimer();
    const removedState = map.delete(state.sessionId);
    if (removedState || removedEvicted) recentReaderSessions.delete(state.sessionId);
    return removedState || removedEvicted;
  }
  const shared = shareSession(prev, state);
  if (shared === prev) return false;
  map.delete(state.sessionId);
  map.set(state.sessionId, shared);
  return true;
}

function setState(state: VisualizeSessionState): void {
  const evictedEntry = evictedSessions.get(state.sessionId);
  const evictedHadTabs = (evictedEntry?.versions.size ?? 0) > 0;
  const next = new Map(states);
  if (!putState(next, state)) return;
  replaceStates(next, evictedEntry ? [state.sessionId] : undefined);
  if (evictedHadTabs && !next.get(state.sessionId)?.tabs.length) notifyEmptied(state.sessionId);
  enforceRendererCacheBudget();
}

/** `next` becomes the state; a session whose last tab went away is told to
 *  the shell (its 'visualize' panel view has nothing left to show). */
function replaceStates(next: Map<string, VisualizeSessionState>, alsoPrune?: Iterable<string>): void {
  const before = states;
  setStatesMap(next);
  for (const sessionId of [...recentReaderSessions]) {
    if (!next.has(sessionId) && !evictedSessions.has(sessionId)) recentReaderSessions.delete(sessionId);
  }
  const pruned = new Set<string>();
  const pruneOnce = (sessionId: string, state: VisualizeSessionState | undefined) => {
    if (pruned.has(sessionId)) return;
    pruneSessionPaneState(sessionId, state);
    pruned.add(sessionId);
  };
  for (const [sessionId, state] of before) {
    const now = next.get(sessionId);
    if (now !== state) pruneOnce(sessionId, now);
  }
  for (const [sessionId, now] of next) {
    if (!before.has(sessionId)) pruneOnce(sessionId, now);
  }
  if (alsoPrune) {
    for (const sessionId of alsoPrune) pruneOnce(sessionId, next.get(sessionId));
  }
  emit();
  for (const [sessionId, state] of before) {
    if (state.tabs.length && !next.get(sessionId)?.tabs.length) {
      notifyEmptied(sessionId);
    }
  }
}

/** The shell clears a session's 'visualize' panel view through this once
 *  its last tab closed (the user's ×, the agent's close, eviction), wherever
 *  that panel is: one off screen would otherwise come back as an empty frame. */
export function onVisualizeEmptied(listener: RevealListener): () => void {
  connect();
  emptiedListeners.add(listener);
  return () => {
    emptiedListeners.delete(listener);
  };
}

// The app window's CSP frame-src may not frame another origin, so the page script hands the address over.
export function openVisualizePageLink(sessionId: string, url: string, external = false): void {
  if (typeof navigator === 'undefined' || !navigator.userActivation?.isActive) return;
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable(), external }) === 'pane') {
    requestBrowserPage(sessionId, url, { newTab: true });
    return;
  }
  void window.mixdogDesktop?.openExternal?.(url)?.catch(() => {});
}

function markUpdatedTab(
  sessionId: string,
  shown: VisualizeSessionState | undefined,
  updated: string | undefined
): void {
  if (updated && shown?.tabs.some((tab) => tab.id === updated))
    setUpdated(sessionId, updated, shown.active !== updated);
}

/** Apply one main-process event (exported for tests). */
export function applyVisualizeEvent(event: DesktopVisualizeEvent): void {
  // A zoom gesture from inside a pane frame names no session.
  if (event?.zoomModifier !== undefined) {
    emitVisualizeZoomModifier(event.zoomModifier);
    return;
  }
  if (event?.zoom) {
    emitVisualizeZoomInput(event.zoom, event.point);
    return;
  }
  const sessionId = String(event?.sessionId || '');
  if (!sessionId) return;
  if (event.openUrl) {
    requestBrowserPage(sessionId, event.openUrl, {
      newTab: true,
      agent: true,
      ...(event.openRequestId ? { requestId: event.openRequestId } : {}),
    });
  }
  const state = event.state ? { ...event.state, sessionId } : undefined;
  if (event.held && !state) return;
  // `state` is what the session shows, held or not. A change of the hold is
  // announced after that state is applied (below), so no reader sees a turn's
  // end with the state from before it.
  const before = heldSince.get(sessionId);
  const held = Boolean(state && event.held);
  const released = Boolean(state && !event.held && before !== undefined);
  const since = Number.isFinite(event.heldSince) ? Number(event.heldSince) : (before ?? 0);
  if (held) {
    heldSince.set(sessionId, since);
    setHeldCallsFor(sessionId, event.heldCalls);
  }
  if (released) {
    heldSince.delete(sessionId);
    heldCalls.delete(sessionId);
  }
  // A tab the user picked holds the panel no longer than the turn it was
  // picked before or during: not against what a new turn opens, and not
  // against a turn's own opens at its end (also the end of a turn whose
  // successor already runs: the hold moves on to that one's start).
  if (released || (held && since !== before)) userPicks.delete(sessionId);
  // An agent open or a content update carries `reveal` (and, from current
  // hosts, the tab it was for): the open policy decides what shows.
  if (event.reveal) showUpdatedTab(sessionId, event.tab || state?.active || '', state);
  else if (state) {
    // A file-change update lands in place: nothing is activated or revealed;
    // a tab that is not the active one wears the dot until it is viewed.
    const shown = keptLocalActive(state);
    setState(shown);
    markUpdatedTab(sessionId, shown, event.updated);
  }
  if (released || held) emit();
}

/** Whether an open or update of `tabId` brings the panel up on it (the open
 *  policy): no, only while the panel is on screen on another tab the user
 *  picked that still exists. */
export function visualizeUpdateShows(
  state: Pick<VisualizeSessionState, 'tabs'>,
  tabId: string,
  panelOnScreen: boolean,
  pick: string | undefined
): boolean {
  return !(panelOnScreen && pick && pick !== tabId && state.tabs.some((tab) => tab.id === pick));
}

function sendActivate(sessionId: string, tabId: string): void {
  void globalThis.window?.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId, action: 'activate' })?.catch(() => {});
}

function setUpdated(sessionId: string, tabId: string, updated: boolean): void {
  const current = updatedTabs.get(sessionId) ?? NO_UPDATES;
  if (current.has(tabId) === updated) return;
  const next = new Set(current);
  if (updated) next.add(tabId);
  else next.delete(tabId);
  updatedTabs = new Map(updatedTabs);
  if (next.size) updatedTabs.set(sessionId, next);
  else updatedTabs.delete(sessionId);
  emit();
}

/** The phone layout with the session's panel off screen: the agent neither
 *  shows it nor moves its selection. */
function phonePanelClosed(sessionId: string): boolean {
  return !onScreen.has(sessionId) && isMobileRemoteSurface();
}

/** `incoming` keeping this renderer's selected tab while the phone's panel
 *  is closed (and that tab still exists); otherwise `incoming` as main has it. */
function keptLocalActive(incoming: VisualizeSessionState, evictedActive?: string | null): VisualizeSessionState {
  const local =
    states.get(incoming.sessionId)?.active ?? evictedActive ?? evictedSessions.get(incoming.sessionId)?.active;
  if (!local || local === incoming.active || !phonePanelClosed(incoming.sessionId)) return incoming;
  return incoming.tabs.some((tab) => tab.id === local) ? { ...incoming, active: local } : incoming;
}

/** Consumes the session's pending user open when `tab` is exactly its
 *  target and it has not expired. */
function takeUserOpen(sessionId: string, tab: VisualizeTabView | undefined): boolean {
  const pending = userOpens.get(sessionId);
  if (!pending) return false;
  if (pending.expires <= Date.now()) {
    userOpens.delete(sessionId);
    return false;
  }
  if (!tab || !pending.matches(tab)) return false;
  userOpens.delete(sessionId);
  return true;
}

/** Consumes the session's pending preview open of exactly `tab` (expired
 *  ones are dropped); null when there is none. */
function takePreviewOpen(sessionId: string, tab: VisualizeTabView | undefined): UserOpen | null {
  const now = Date.now();
  const pending = (previewOpens.get(sessionId) ?? []).filter((open) => open.expires > now);
  const at = tab ? pending.findIndex((open) => open.matches(tab)) : -1;
  const [taken] = at >= 0 ? pending.splice(at, 1) : [];
  if (pending.length) previewOpens.set(sessionId, pending);
  else previewOpens.delete(sessionId);
  return taken ?? null;
}

/** The user keeps the session's panel closed right now. */
function panelClosedByUser(sessionId: string): boolean {
  return visualizeRevealSuppressed(sessionId) && !onScreen.has(sessionId);
}

function showUpdatedTab(sessionId: string, tabId: string, incoming?: VisualizeSessionState): void {
  const base = incoming ?? states.get(sessionId);
  if (!base) return;
  const opened = base.tabs.find((tab) => tab.id === tabId);
  const user = takeUserOpen(sessionId, opened);
  // A turn preview's open: whether the user keeps the panel closed is asked
  // now, at its reveal, so a close made while it was pending holds.
  const preview = user ? null : takePreviewOpen(sessionId, opened);
  if (preview?.silent) {
    // A preview behind the turn's own opens: the panel stays on what it
    // shows (the agent's tab); the preview's tab only wears the dot.
    const local = states.get(sessionId)?.active ?? evictedSessions.get(sessionId)?.active;
    const active = local && base.tabs.some((tab) => tab.id === local) ? local : base.active;
    setState(base.active === active ? base : { ...base, active });
    if (active && base.active !== active) sendActivate(sessionId, active);
    if (tabId && tabId !== active && base.tabs.some((tab) => tab.id === tabId)) setUpdated(sessionId, tabId, true);
    return;
  }
  if (!user && (phonePanelClosed(sessionId) || (preview && panelClosedByUser(sessionId)))) {
    const kept = keptLocalActive(base);
    setState(kept);
    if (tabId && kept.tabs.some((tab) => tab.id === tabId)) setUpdated(sessionId, tabId, kept.active !== tabId);
    return;
  }
  const pick = userPicks.get(sessionId);
  if (pick && !visualizeUpdateShows(base, tabId, onScreen.has(sessionId), pick)) {
    setState(base.active === pick ? base : { ...base, active: pick });
    if (base.active !== pick) sendActivate(sessionId, pick);
    if (tabId) setUpdated(sessionId, tabId, true);
    return;
  }
  userPicks.delete(sessionId);
  const shown = base.tabs.some((tab) => tab.id === tabId) ? tabId : base.active;
  setState(shown && base.active !== shown ? { ...base, active: shown } : base);
  if (shown) {
    if (base.active !== shown) sendActivate(sessionId, shown);
    setUpdated(sessionId, shown, false);
  }
  allowVisualizeReveal(sessionId);
  requestReveal(sessionId);
}

/** Tabs opened or updated behind the user's pick (the strip marks them). */
export function visualizeUpdatedTabs(sessionId: string): ReadonlySet<string> {
  return updatedTabs.get(sessionId) ?? NO_UPDATES;
}

export function useVisualizeUpdatedTabs(sessionId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => visualizeUpdatedTabs(sessionId),
    () => NO_UPDATES
  );
}

/** The session's panel came on screen (true) or left it: while it is off,
 *  the user's tab pick no longer holds back opens and updates. */
export function setVisualizePanelOnScreen(sessionId: string, shown: boolean): void {
  if (!sessionId) return;
  const was = onScreen.has(sessionId);
  let rehydrateReset = false;
  if (shown) {
    onScreen.add(sessionId);
    if (states.has(sessionId)) {
      touchState(sessionId);
    } else {
      const evicted = evictedSessions.get(sessionId);
      if (evicted) {
        if (evicted.failed) {
          evicted.failed = false;
          rehydrateReset = true;
        }
        evicted.retries = 0;
        rehydrateEvicted();
      }
    }
  } else {
    onScreen.delete(sessionId);
    userPicks.delete(sessionId);
  }
  if (was === shown && !rehydrateReset) return;
  // Chat card tiles outline the shown tab only while the panel is on screen.
  emit();
  if (was === shown) return;
  // A paired device tells the desktop (remote-shim-api.ts): an agent open
  // counts as seen on it only while its panel is on screen.
  const view = globalThis.window;
  if (view?.dispatchEvent) view.dispatchEvent(new view.CustomEvent(VISUALIZE_PANELS_EVENT, { detail: [...onScreen] }));
}

/** Whether the session's visualize panel is on screen right now. */
export function visualizePanelOnScreen(sessionId: string): boolean {
  return onScreen.has(sessionId);
}

export function useVisualizePanelOnScreen(sessionId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => visualizePanelOnScreen(sessionId),
    () => false
  );
}

/** The newest version number of each tab (0 without versions). */
function tabVersions(state: VisualizeSessionState | undefined): Map<string, number> {
  return new Map((state?.tabs ?? []).map((tab) => [tab.id, tab.versions?.at(-1)?.n ?? 0]));
}

/** Panels a reload or resume should bring back: open before, not closed by
 *  the user since, and still with tabs. */
function rememberedOpen(state: VisualizeSessionState): boolean {
  const memory = panelMemory();
  return state.tabs.length > 0 && memory.open.has(state.sessionId) && !memory.closed.has(state.sessionId);
}

/** What the holds say, to tell whether a snapshot changed them. */
const holdKey = (): string =>
  JSON.stringify(
    [...heldSince]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, since]) => [id, since, [...(heldCalls.get(id) ?? [])].sort()])
  );

/** A snapshot as an event tells it: each session's state is what it shows,
 *  and `held` says a turn's work is kept back since `heldSince`. */
function takeSnapshot(
  snapshot: readonly VisualizeSessionState[] | null | undefined,
  replace: boolean
): { shown: VisualizeSessionState[]; holdsChanged: boolean } {
  const before = holdKey();
  if (replace) {
    heldSince.clear();
    heldCalls.clear();
  }
  const shown: VisualizeSessionState[] = [];
  for (const raw of snapshot ?? []) {
    if (!raw?.sessionId) continue;
    shown.push(applyHeldFromRaw(raw.sessionId, raw));
  }
  return { shown, holdsChanged: holdKey() !== before };
}

export function hydrateVisualizeStates(snapshot: readonly VisualizeSessionState[] | null | undefined): void {
  const reopen: string[] = [];
  const next = new Map(states);
  const { shown, holdsChanged } = takeSnapshot(
    (snapshot ?? []).filter(
      (state) => state?.sessionId && !states.has(state.sessionId) && !evictedSessions.has(state.sessionId)
    ),
    false
  );
  let changed = false;
  for (const state of shown) {
    changed = putState(next, state) || changed;
    if (rememberedOpen(state)) reopen.push(state.sessionId);
  }
  if (changed) setStatesMap(next);
  if (changed || holdsChanged) emit();
  if (changed) enforceRendererCacheBudget();
  if (reopen.length) setTimeout(() => reopen.forEach(requestReveal), 0);
}

function collectResyncReveals(
  before: ReadonlyMap<string, VisualizeSessionState>,
  beforeEvicted: ReadonlyMap<string, EvictedSessionEntry>,
  next: ReadonlyMap<string, VisualizeSessionState>
): { missed: Array<[string, string]>; reopen: string[] } {
  const missed: Array<[string, string]> = [];
  const reopen: string[] = [];
  for (const [sessionId, state] of next) {
    const known = before.has(sessionId)
      ? tabVersions(before.get(sessionId))
      : (beforeEvicted.get(sessionId)?.versions ?? new Map<string, number>());
    const changed = state.tabs.filter((tab) => known.get(tab.id) !== (tab.versions?.at(-1)?.n ?? 0));
    const tab = changed.find((candidate) => candidate.id === state.active) ?? changed.at(-1);
    if (tab) missed.push([sessionId, tab.id]);
    else if (rememberedOpen(state)) reopen.push(sessionId);
  }
  return { missed, reopen };
}

export function resyncVisualizeStates(snapshot: readonly VisualizeSessionState[] | null | undefined): void {
  // A complete replacement, holds included (takeSnapshot).
  const before = states;
  const beforeEvicted = new Map(evictedSessions);
  evictedSessions.clear();
  rehydrateInFlight = null;
  clearRehydrateRetryTimer();
  const { shown, holdsChanged } = takeSnapshot(snapshot, true);
  const next = new Map<string, VisualizeSessionState>();
  for (const state of shown) {
    if (state.tabs.length || state.history?.length)
      next.set(
        state.sessionId,
        shareSession(states.get(state.sessionId), keptLocalActive(state, beforeEvicted.get(state.sessionId)?.active))
      );
  }
  const { missed, reopen } = collectResyncReveals(before, beforeEvicted, next);
  for (const [sessionId] of missed) {
    pendingResyncPins.set(sessionId, (pendingResyncPins.get(sessionId) ?? 0) + 1);
  }
  const emptiedEvicted: string[] = [];
  for (const [sessionId, entry] of beforeEvicted) {
    const now = next.get(sessionId);
    if (!now) recentReaderSessions.delete(sessionId);
    if (!now?.tabs.length && entry.versions.size > 0) emptiedEvicted.push(sessionId);
  }
  const same = next.size === states.size && [...next].every(([id, state]) => states.get(id) === state);
  if (!same) replaceStates(next, beforeEvicted.keys());
  else {
    for (const sessionId of beforeEvicted.keys()) pruneSessionPaneState(sessionId, next.get(sessionId));
    if (holdsChanged || beforeEvicted.size > 0) emit();
  }
  for (const sessionId of emptiedEvicted) notifyEmptied(sessionId);
  if (!same) enforceRendererCacheBudget();
  if (!missed.length && !reopen.length) return;
  const timer = setTimeout(() => {
    resyncTimers.delete(timer);
    try {
      for (const [sessionId, tabId] of missed) showUpdatedTab(sessionId, tabId);
      for (const sessionId of reopen) {
        if (states.has(sessionId) || evictedSessions.has(sessionId)) requestReveal(sessionId);
      }
    } finally {
      for (const [sessionId] of missed) releaseResyncPin(sessionId);
    }
    if (missed.length) enforceRendererCacheBudget();
  }, 0);
  unrefTimer(timer);
  resyncTimers.add(timer);
}

/** Subscribe to main once; a reloaded renderer first reads the current tabs. */
function connect(): void {
  if (connected) return;
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  if (!api?.onVisualizeChanged) return;
  connected = true;
  api.onVisualizeChanged(applyVisualizeEvent);
  void api
    .visualizeState?.()
    .then(hydrateVisualizeStates)
    .catch(() => {});
  // Remote clients only (the desktop never fires these): re-read after a
  // reconnect or a state gap.
  const resync = () => {
    void api
      .visualizeState?.()
      .then(resyncVisualizeStates)
      .catch(() => {
        let shouldRetry = false;
        for (const [, entry] of evictedSessions) {
          if (!entry.failed) continue;
          entry.retries = 0;
          shouldRetry = true;
        }
        if (shouldRetry) scheduleRehydrateRetry();
      });
  };
  window.addEventListener('mixdog:remote-reconnected', resync);
  window.addEventListener('mixdog:remote-state-gap', resync);
  // The phone's visualize adapter asks for the same read when it knows events may have been missed (a dropped part sequence, a core
  // it follows through its section).
  window.addEventListener('mixdog:visualize-resync', resync);
}

/** Subscribe to store changes (exported for tests). */
export function subscribe(listener: Listener): () => void {
  connect();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function visualizeStateFor(sessionId: string): VisualizeSessionState {
  return states.get(sessionId) ?? evictedSessions.get(sessionId)?.placeholder ?? EMPTY;
}

/** Whether `sessionId`'s visualize state was evicted and is waiting on rehydration from main. */
export function isVisualizeStateRehydrating(sessionId: string): boolean {
  const entry = evictedSessions.get(sessionId);
  return Boolean(entry && !entry.failed);
}

export function useVisualizeStateRehydrating(sessionId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isVisualizeStateRehydrating(sessionId),
    () => false
  );
}

export function useVisualizeState(sessionId: string): VisualizeSessionState {
  const surfaceActive = useSurfaceActive();
  const subscribeSession = useCallback(
    (listener: Listener) => {
      const unsubscribe = subscribe(listener);
      if (!sessionId || !surfaceActive) return unsubscribe;
      sessionReaders.set(sessionId, (sessionReaders.get(sessionId) ?? 0) + 1);
      touchRecentReader(sessionId);
      if (states.has(sessionId)) {
        touchState(sessionId);
      } else {
        const evicted = evictedSessions.get(sessionId);
        if (evicted && !evicted.failed) rehydrateEvicted();
      }
      return () => {
        unsubscribe();
        const remaining = (sessionReaders.get(sessionId) ?? 0) - 1;
        if (remaining > 0) sessionReaders.set(sessionId, remaining);
        else {
          sessionReaders.delete(sessionId);
          touchRecentReader(sessionId);
        }
      };
    },
    [sessionId, surfaceActive]
  );
  return useSyncExternalStore(
    subscribeSession,
    () => visualizeStateFor(sessionId),
    () => EMPTY
  );
}

/** While main keeps a running agent turn's work back: when the oldest turn
 *  not shown yet started (ms); else null. */
export function visualizeHeldSince(sessionId: string): number | null {
  return heldSince.get(sessionId) ?? null;
}

/** Chat cards of the running turn's opens wait for its end (see
 *  `visualizeHeldSince`): none is drawn, or changes, while the turn runs. */
export function useVisualizeHeldSince(sessionId: string): number | null {
  return useSyncExternalStore(
    subscribe,
    () => visualizeHeldSince(sessionId),
    () => null
  );
}

/** Tool call ids held by the session's running turn(s), or null when none. */
export function visualizeHeldCalls(sessionId: string): ReadonlySet<string> | null {
  return heldCalls.get(sessionId) ?? null;
}

export function useVisualizeHeldCalls(sessionId: string): ReadonlySet<string> | null {
  return useSyncExternalStore(
    subscribe,
    () => visualizeHeldCalls(sessionId),
    () => null
  );
}

/** True once any session has visualize tabs: the dock toggle appears then. */
export function useVisualizeAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => states.size > 0 || evictedSessions.size > 0,
    () => false
  );
}

/** The app shell reveals a session's visualize panel through this. */
export function onVisualizeRevealRequested(listener: RevealListener): () => void {
  connect();
  revealListeners.add(listener);
  const pending = [...pendingReveals];
  pendingReveals.clear();
  for (const sessionId of pending) listener(sessionId);
  return () => {
    revealListeners.delete(listener);
  };
}

/** The user closed the panel: a renderer reload or a remote resume does not
 *  bring it back (the next agent open or update still does). */
export function suppressVisualizeReveal(sessionId: string): void {
  if (!sessionId) return;
  const memory = panelMemory();
  memory.closed.add(sessionId);
  memory.open.delete(sessionId);
  savePanelMemory();
}

/** The user opened the panel again: agent opens may reveal it once more. */
export function allowVisualizeReveal(sessionId: string): void {
  if (panelMemory().closed.delete(sessionId)) savePanelMemory();
}

export function visualizeRevealSuppressed(sessionId: string): boolean {
  return panelMemory().closed.has(sessionId);
}

/** The session's visualize panel is on screen: remembered across a reload. */
export function markVisualizePanelShown(sessionId: string): void {
  if (!sessionId) return;
  const memory = panelMemory();
  if (memory.open.has(sessionId) && !memory.closed.has(sessionId)) return;
  memory.open.add(sessionId);
  memory.closed.delete(sessionId);
  savePanelMemory();
}

/** The session's panel moved to another view: a reload leaves it there. */
export function markVisualizePanelHidden(sessionId: string): void {
  if (panelMemory().open.delete(sessionId)) savePanelMemory();
}

/** Below this body width, 2-3 panes stack instead of sharing the width. */
const VISUALIZE_SIDE_BY_SIDE_MIN_WIDTH = 2 * 360;

export function visualizePanesStacked(bodyWidth: number, paneCount: number): boolean {
  return paneCount > 1 && bodyWidth > 0 && bodyWidth < VISUALIZE_SIDE_BY_SIDE_MIN_WIDTH;
}

interface VisualizeHeaderAction {
  id: string;
  inline?: boolean;
  checkbox?: boolean;
  separatorBefore?: boolean;
}

export function visualizeHeaderActions<T extends VisualizeHeaderAction>(actions: readonly T[]): T[] {
  const toggles = actions.filter((action) => !action.inline && action.checkbox);
  const menu = actions.filter((action) => !action.inline && !action.checkbox);
  return [
    ...actions.filter((action) => action.inline),
    ...toggles,
    ...menu.map((action, index) => (index === 0 && toggles.length ? { ...action, separatorBefore: true } : action)),
  ];
}

/** A tab's tooltip: its full label, then every target it shows. */
export function visualizeTabTooltip(tab: Pick<VisualizeSessionState['tabs'][number], 'label' | 'panes'>): string {
  return [tab.label, ...tab.panes.map((pane) => pane.target)].join('\n');
}

/** The user picked `tabId` (the tab strip, a chat card): it holds the panel
 *  against opens and updates of other tabs while the panel stays on screen. */
export function activateVisualizeTab(sessionId: string, tabId: string): void {
  userPicks.set(sessionId, tabId);
  setUpdated(sessionId, tabId, false);
  const state = states.get(sessionId);
  if (state && state.active !== tabId) setState({ ...state, active: tabId });
  else {
    const evicted = evictedSessions.get(sessionId);
    if (evicted) evicted.active = tabId;
  }
  sendActivate(sessionId, tabId);
}

/** A chat card click on a live tab: the user's own request, so it lifts the
 *  user-closed rule, selects the tab and reveals the session's panel. */
export function revealVisualizeTab(sessionId: string, tabId: string): void {
  allowVisualizeReveal(sessionId);
  activateVisualizeTab(sessionId, tabId);
  requestReveal(sessionId);
}

/** A chat card click on a closed tab: open the same file targets again (no
 *  agent turn); main's open then reveals the panel, which the click allowed. */
export function reopenVisualizeTargets(sessionId: string, tabId: string, targets: string[], label = ''): Promise<void> {
  const matches = (tab: VisualizeTabView) => {
    const live = livePanes(tab);
    return live.length === targets.length && live.every((pane, index) => sameTarget(pane.target, targets[index]));
  };
  return userOpen(sessionId, matches, () =>
    window.mixdogDesktop?.visualizeCommand?.({
      sessionId,
      tabId,
      action: 'reopen',
      targets,
      ...(label ? { label } : {}),
    })
  );
}

export async function openTurnPreviews(
  sessionId: string,
  targets: readonly string[],
  { reveal = true }: { reveal?: boolean } = {}
): Promise<void> {
  for (const target of targets) {
    const request: UserOpen = {
      matches: (tab) => {
        const live = livePanes(tab);
        return live.length === 1 && sameTarget(live[0].target, target);
      },
      expires: Date.now() + USER_OPEN_TTL_MS,
      ...(reveal ? {} : { silent: true }),
    };
    previewOpens.set(sessionId, [...(previewOpens.get(sessionId) ?? []), request]);
    try {
      await window.mixdogDesktop?.visualizeCommand?.({
        sessionId,
        tabId: 'preview',
        action: 'reopen',
        targets: [target],
      });
    } catch (error) {
      const left = (previewOpens.get(sessionId) ?? []).filter((open) => open !== request);
      if (left.length) previewOpens.set(sessionId, left);
      else previewOpens.delete(sessionId);
      console.warn(`turn preview did not open (${target}):`, error instanceof Error ? error.message : error);
    }
  }
}

/** The host's reuse identity of inline content (main `inlineKey`): its
 *  title, else its kind and exact source (main hashes the source). */
function sameInlineIdentity(a: VisualizeInlineContent, b: VisualizeInlineContent): boolean {
  if (a.title || b.title) return a.title === b.title;
  return a.kind === b.kind && a.source === b.source;
}

function userOpen(
  sessionId: string,
  matches: (tab: VisualizeTabView) => boolean,
  send: () => Promise<unknown> | undefined
): Promise<void> {
  const live = states.get(sessionId)?.tabs.find(matches);
  if (live) {
    revealVisualizeTab(sessionId, live.id);
    return Promise.resolve();
  }
  return awaitUserOpen(sessionId, matches, send);
}

/** Sends a user's open request and lets the open of exactly the tab
 *  `matches` names (within USER_OPEN_TTL_MS) show the panel. */
function awaitUserOpen(
  sessionId: string,
  matches: (tab: VisualizeTabView) => boolean,
  send: () => Promise<unknown> | undefined
): Promise<void> {
  allowVisualizeReveal(sessionId);
  const sent = send();
  if (!sent) return Promise.resolve();
  const pending: UserOpen = { matches, expires: Date.now() + USER_OPEN_TTL_MS };
  userOpens.set(sessionId, pending);
  return sent.then(
    () => undefined,
    (error) => {
      if (userOpens.get(sessionId) === pending) userOpens.delete(sessionId);
      throw error;
    }
  );
}

/** The same for a closed inline tab: open its stored content again. */
export function reopenVisualizeContent(
  sessionId: string,
  tabId: string,
  content: VisualizeInlineContent,
  label = ''
): Promise<void> {
  const matches = (tab: VisualizeTabView) => {
    const live = livePanes(tab);
    const shown = live[0]?.inline;
    return live.length === 1 && !!shown && sameInlineIdentity(shown, content);
  };
  return userOpen(sessionId, matches, () =>
    window.mixdogDesktop?.visualizeCommand?.({
      sessionId,
      tabId,
      action: 'reopen',
      targets: [],
      content,
      ...(label ? { label } : {}),
    })
  );
}

/** "All visuals": select history entry `entry`'s open tab, or open it again
 *  when closed (no agent turn). The user's own request, so it lifts the
 *  user-closed rule like a chat card press. */
export function openVisualizeHistory(sessionId: string, entry: string): Promise<void> {
  const send = () => window.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId: '', action: 'history', entry });
  const item = states.get(sessionId)?.history?.find((candidate) => candidate.id === entry);
  if (item?.open) {
    // Open already: main only selects it and reveals nothing, so the panel
    // is shown now (its selection follows main's state) and nothing waits.
    allowVisualizeReveal(sessionId);
    requestReveal(sessionId);
    return send()?.then(() => undefined) ?? Promise.resolve();
  }
  // Closed: main opens it as a new tab under the entry's label.
  return awaitUserOpen(sessionId, (tab) => tab.label === item?.label, send);
}

/** Export displayed pane `pane` of a tab (see `DesktopVisualizeTabCommand`);
 *  resolves with where it went, or nothing. */
export async function exportVisualizeTab(
  sessionId: string,
  tabId: string,
  format: 'png' | 'pdf' | 'project',
  pane: number
): Promise<VisualizeCommandResult | undefined> {
  return (
    (await window.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId, action: 'export', format, pane })) || undefined
  );
}

/** The displayed pane the toolbar's export acts on: the live one while a
 *  kept version sits beside it, else the first. */
export function visualizeExportPane(tab: Pick<VisualizeSessionState['tabs'][number], 'compare' | 'panes'>): number {
  return tab.compare ? Math.max(0, tab.panes.length - 1) : 0;
}

/** When a list entry was opened: the time today, else the date and time. */
export function visualizeHistoryTime(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(uiFormatLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    ...timeFormatOptions(),
  });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(uiFormatLocale(), { month: 'short', day: 'numeric' })} ${time}`;
}

export function closeVisualizeTab(sessionId: string, tabId: string): void {
  void window.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId, action: 'close' })?.catch(() => {});
}

type VisualizeTabState = VisualizeSessionState['tabs'][number];

/** The version stepper's position: the shown version (the newest when live,
 *  or null when live content was not kept as a version) and the newest; null
 *  while the tab keeps fewer than two versions and live is kept. */
export function visualizeVersionPosition(tab: Pick<VisualizeTabState, 'versions' | 'version' | 'liveUnkept'>): {
  shown: number | null;
  newest: number;
} | null {
  const list = tab.versions ?? [];
  const newest = list.at(-1)?.n;
  if (newest === undefined || (list.length < 2 && tab.version == null && !tab.liveUnkept)) return null;
  return { shown: tab.version ?? (tab.liveUnkept ? null : newest), newest };
}

/** The version one step older (-1) or newer (+1) than the shown one: a kept
 *  version number, null for live (stepping onto the newest when kept, or past
 *  the newest when live is unkept), or undefined when there is none that way. */
export function visualizeVersionStep(
  tab: Pick<VisualizeTabState, 'versions' | 'version' | 'liveUnkept'>,
  direction: -1 | 1
): number | null | undefined {
  const list = tab.versions ?? [];
  const position = visualizeVersionPosition(tab);
  if (!position) return undefined;
  if (position.shown === null) {
    return direction === -1 ? position.newest : undefined;
  }
  const index = list.findIndex((version) => version.n === position.shown);
  if (index < 0) return undefined;
  const next = list[index + direction];
  if (!next) return direction === 1 && tab.liveUnkept ? null : undefined;
  return !tab.liveUnkept && next.n === position.newest ? null : next.n;
}

/** Show kept version `version` (null = back to live), beside live when
 *  `compare`; rejects when the host cannot (an evicted version, a tab the
 *  running turn has changed or closed). */
export async function requestVisualizeVersion(
  sessionId: string,
  tabId: string,
  version: number | null,
  compare = false
): Promise<void> {
  await window.mixdogDesktop?.visualizeCommand?.({
    sessionId,
    tabId,
    action: 'version',
    version,
    ...(compare ? { compare: true } : {}),
  });
}

/** The card picture kept of the tab's version `version` (taken when its turn
 *  ended); undefined when it has none or the host cannot say. */
export async function readVisualizeVersionThumbnail(
  sessionId: string,
  tabId: string,
  version: number
): Promise<string | undefined> {
  const result = await window.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId, action: 'thumbnail', version });
  return visualizeThumbnail(result?.thumbnail) || undefined;
}

/** Toggle Compare: on from live compares the previous version with live.
 *  Rejects as `requestVisualizeVersion` does. */
export function toggleVisualizeCompare(sessionId: string, tab: VisualizeTabState): Promise<void> {
  if (tab.compare) return requestVisualizeVersion(sessionId, tab.id, tab.version ?? null);
  const version = tab.version ?? visualizeVersionStep(tab, -1);
  return typeof version === 'number' ? requestVisualizeVersion(sessionId, tab.id, version, true) : Promise.resolve();
}

/** An inline pane (displayed index `pane`) finished rendering; `error` is why
 *  it could not, which main lists with the tab's page problems. */
export function reportVisualizeRender(
  sessionId: string,
  tabId: string,
  pane: number,
  renderId: string | undefined,
  error?: string
): void {
  // Panes carry the id issued for this render (the desktop window's, or a
  // paired client's own); older hosts issue none to remote clients.
  if (!renderId) return;
  void window.mixdogDesktop
    ?.visualizeCommand?.({
      sessionId,
      tabId,
      action: 'render',
      pane,
      renderId,
      ...(error ? { error: error.slice(0, 2000) } : {}),
    })
    ?.catch(() => {});
}

/** A remote page frame refused an outside request (`url`, asked for by
 *  `resource`): the host lists it with the tab's page problems. */
export function reportVisualizeBlockedNetwork(
  sessionId: string,
  tabId: string,
  pane: number,
  url: string,
  resource: string
): void {
  void window.mixdogDesktop
    ?.visualizeCommand?.({ sessionId, tabId, action: 'blocked', pane, url, resource })
    ?.catch(() => {});
}

/** Write kept version `version` back to the project files, with the page
 *  `assets` the confirm listed (callers confirm). */
export function restoreVisualizeVersion(
  sessionId: string,
  tabId: string,
  version: number,
  assets: string[] = []
): Promise<void> {
  return (
    window.mixdogDesktop
      ?.visualizeCommand?.({
        sessionId,
        tabId,
        action: 'restore',
        version,
        ...(assets.length ? { assets } : {}),
      })
      ?.then(() => undefined) ?? Promise.resolve()
  );
}

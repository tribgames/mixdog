// The agent `visualize` tool's side-panel tabs as the renderer sees them. Main
// owns the state and pushes every change; this store mirrors it per session,
// hands web URLs to the session's browser panel, and relays reveal requests to
// the app shell (which owns the pane docks).
import { useSyncExternalStore } from 'react';

import {
  type DesktopVisualizeEvent,
  type VisualizeCommandResult,
  type VisualizeInlineContent,
  type VisualizeSessionState,
  type VisualizeTabView,
  visualizeThumbnail,
} from '../shared/visualize';
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { linkOpenTarget } from './link-open-target';
import { isMobileRemoteSurface } from './mobile-surface';
import { timeFormatOptions } from './time-format-preference';
import { sameTarget } from './visualize-card-model';
import { emitVisualizeZoomInput, emitVisualizeZoomModifier } from './visualize-zoom';

type Listener = () => void;
type RevealListener = (sessionId: string) => void;

const EMPTY: VisualizeSessionState = Object.freeze({ sessionId: '', tabs: [], active: null });

let states = new Map<string, VisualizeSessionState>();
/** What a running agent turn has made so far, per session (`held` events):
 *  the panel keeps drawing `states`; chat cards read this. The turn's end
 *  (an ordinary event) or the user asking to see a tab replaces it. */
let heldStates = new Map<string, VisualizeSessionState>();
/** When each held session's turn started (ms), as main reported it. */
const heldSince = new Map<string, number>();
const listeners = new Set<Listener>();
const revealListeners = new Set<RevealListener>();
const emptiedListeners = new Set<RevealListener>();
/** Reveals asked for before the app shell subscribed (a reloaded renderer
 *  hydrates before its effects run); delivered to the first listener. */
const pendingReveals = new Set<string>();
let connected = false;

/** Per-session panel memory, kept in localStorage so it survives a renderer
 *  reload and a phone whose page was discarded in the background (a WebView
 *  restarted by the OS keeps no sessionStorage); main keeps the tabs, the
 *  renderer forgets which panels it showed.
 *  `open`: the panel was on screen and not closed by the user since.
 *  `closed`: the user closed it — a renderer reload or a remote resume does
 *  not bring it back. An agent open or update still does (the open policy
 *  below) and lifts the mark. */
const PANEL_MEMORY_KEY = 'mixdog.visualize.panels.v1';

/*
 * The open policy. Every agent `open` and every content update of a tab
 * (its file changed, or the agent opened it again) brings the session's
 * visualize panel up on that tab — unless the panel is on screen showing
 * another tab the user picked themselves; then the tab only gets an
 * "updated" mark until it is viewed. The phone layout never brings the panel
 * up for the agent: only the user opens it (a turn card tile, the dock); an
 * update while it is on screen lands as on the desktop.
 * A pick lasts while the panel stays on screen; once it leaves (closed,
 * another dock view, another session) the next open or update takes over.
 */
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

/** Test seam: forget the in-memory panel memory so storage is re-read. */
export function resetVisualizePanelMemory(): void {
  panelMemoryCache = null;
  onScreen.clear();
  userPicks.clear();
  userOpens.clear();
  previewOpens.clear();
  updatedTabs = new Map();
  heldStates = new Map();
  heldSince.clear();
}

function emit(): void {
  for (const listener of listeners) listener();
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
  if (!(state.tabs.length || state.history?.length)) return map.delete(state.sessionId);
  const shared = shareSession(prev, state);
  if (shared === prev) return false;
  map.set(state.sessionId, shared);
  return true;
}

function setState(state: VisualizeSessionState): void {
  const next = new Map(states);
  if (!putState(next, state)) return;
  replaceStates(next);
}

/** `next` becomes the state; a session whose last tab went away is told to
 *  the shell (its 'visualize' panel view has nothing left to show). */
function replaceStates(next: Map<string, VisualizeSessionState>): void {
  const before = states;
  states = next;
  emit();
  for (const [sessionId, state] of before) {
    if (state.tabs.length && !next.get(sessionId)?.tabs.length) {
      for (const listener of emptiedListeners) listener(sessionId);
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

/** A web link clicked in a pane page opens where a chat web link would: the
 *  app window may not frame another origin (its CSP frame-src), so the page
 *  script hands the address over instead of navigating to an error page. A
 *  click in the pane frame activates this document too; a message a page
 *  script posts by itself carries no activation and opens nothing. */
export function openVisualizePageLink(sessionId: string, url: string, external = false): void {
  if (typeof navigator === 'undefined' || !navigator.userActivation?.isActive) return;
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable(), external }) === 'pane') {
    requestBrowserPage(sessionId, url, { newTab: true });
    return;
  }
  void window.mixdogDesktop?.openExternal?.(url)?.catch(() => {});
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
  if (event.held) {
    // Mid-turn: nothing in the panel opens, activates or reloads; a tab whose
    // files the turn changed wears the "updated" dot.
    if (!state) return;
    heldStates = new Map(heldStates);
    heldStates.set(sessionId, state);
    if (Number.isFinite(event.heldSince)) heldSince.set(sessionId, Number(event.heldSince));
    emit();
    const shown = states.get(sessionId);
    if (event.updated && shown?.tabs.some((tab) => tab.id === event.updated)) {
      setUpdated(sessionId, event.updated, shown.active !== event.updated);
    }
    return;
  }
  const released = Boolean(state && heldStates.has(sessionId));
  if (released) {
    // The turn ended. Its end is announced after the final state is applied
    // (below), so no reader sees the end of the hold with the state from
    // before the turn.
    heldStates = new Map(heldStates);
    heldStates.delete(sessionId);
    heldSince.delete(sessionId);
  }
  // An agent open or a content update carries `reveal` (and, from current
  // hosts, the tab it was for): the open policy decides what shows.
  if (event.reveal) showUpdatedTab(sessionId, event.tab || state?.active || '', state);
  else if (state) {
    // A file-change update lands in place: nothing is activated or revealed;
    // a tab that is not the active one wears the dot until it is viewed.
    const shown = keptLocalActive(state);
    setState(shown);
    if (event.updated && shown.tabs.some((tab) => tab.id === event.updated)) {
      setUpdated(sessionId, event.updated, shown.active !== event.updated);
    }
  }
  if (released) emit();
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
function keptLocalActive(incoming: VisualizeSessionState): VisualizeSessionState {
  const local = states.get(incoming.sessionId)?.active;
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
 *  ones are dropped). */
function takePreviewOpen(sessionId: string, tab: VisualizeTabView | undefined): boolean {
  const now = Date.now();
  const pending = (previewOpens.get(sessionId) ?? []).filter((open) => open.expires > now);
  const at = tab ? pending.findIndex((open) => open.matches(tab)) : -1;
  if (at >= 0) pending.splice(at, 1);
  if (pending.length) previewOpens.set(sessionId, pending);
  else previewOpens.delete(sessionId);
  return at >= 0;
}

/** The user keeps the session's panel closed right now. */
function panelClosedByUser(sessionId: string): boolean {
  return visualizeRevealSuppressed(sessionId) && !onScreen.has(sessionId);
}

/** Apply the open policy to an open or update of `tabId` (`incoming`: the
 *  state that came with it). Shown: the tab becomes active (main told when it
 *  did not pick it itself, as for a file-change update) and the panel is
 *  revealed, lifting a user close. Kept: the user's tab stays (main told
 *  again when the open moved it) and `tabId` is marked updated. */
function showUpdatedTab(sessionId: string, tabId: string, incoming?: VisualizeSessionState): void {
  const base = incoming ?? states.get(sessionId);
  if (!base) return;
  const opened = base.tabs.find((tab) => tab.id === tabId);
  const user = takeUserOpen(sessionId, opened);
  // A turn preview's open: whether the user keeps the panel closed is asked
  // now, at its reveal, so a close made while it was pending holds.
  const preview = !user && takePreviewOpen(sessionId, opened);
  if (!user && (phonePanelClosed(sessionId) || (preview && panelClosedByUser(sessionId)))) {
    // Phone: an agent open or update never brings the panel up or moves its
    // selection; the tab is only made or updated (the turn card's tile opens
    // it), and one not selected wears the dot. A turn's previews do the same
    // while the user keeps the panel closed.
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
  if (shown) onScreen.add(sessionId);
  else {
    onScreen.delete(sessionId);
    userPicks.delete(sessionId);
  }
  // Chat card tiles outline the shown tab only while the panel is on screen.
  if (was !== shown) emit();
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

/** Apply main's tab snapshot after a renderer (re)load (exported for tests):
 *  a session whose panel was open before the reload gets it back, unless the
 *  user had closed it. The reveal waits a turn so the shell has rendered the
 *  visualize view the new tabs make available. */
export function hydrateVisualizeStates(snapshot: readonly VisualizeSessionState[] | null | undefined): void {
  const reopen: string[] = [];
  const next = new Map(states);
  let changed = false;
  for (const state of snapshot ?? []) {
    if (!state?.sessionId || states.has(state.sessionId)) continue;
    changed = putState(next, state) || changed;
    if (rememberedOpen(state)) reopen.push(state.sessionId);
  }
  if (changed) {
    states = next;
    emit();
  }
  if (reopen.length) setTimeout(() => reopen.forEach(requestReveal), 0);
}

/** A paired remote client back from a gap — a phone resumed from the
 *  background, a dropped link (exported for tests): pushes may have been
 *  missed meanwhile, so the host's snapshot replaces every session's tabs.
 *  Then, a turn later (the shell renders the visualize view first): a tab
 *  opened or updated during the gap goes through the open policy as its
 *  missed push would have, and a panel that was open before the gap (not
 *  closed by the user) is brought back. */
export function resyncVisualizeStates(snapshot: readonly VisualizeSessionState[] | null | undefined): void {
  const before = states;
  const next = new Map<string, VisualizeSessionState>();
  for (const state of snapshot ?? []) {
    if (state?.sessionId && (state.tabs.length || state.history?.length)) {
      next.set(state.sessionId, shareSession(states.get(state.sessionId), keptLocalActive(state)));
    }
  }
  const same = next.size === states.size && [...next].every(([id, state]) => states.get(id) === state);
  if (!same) replaceStates(next);
  const missed: Array<[string, string]> = [];
  const reopen: string[] = [];
  for (const [sessionId, state] of next) {
    const known = tabVersions(before.get(sessionId));
    const changed = state.tabs.filter((tab) => known.get(tab.id) !== (tab.versions?.at(-1)?.n ?? 0));
    const tab = changed.find((candidate) => candidate.id === state.active) ?? changed.at(-1);
    if (tab) missed.push([sessionId, tab.id]);
    else if (rememberedOpen(state)) reopen.push(sessionId);
  }
  if (!missed.length && !reopen.length) return;
  setTimeout(() => {
    for (const [sessionId, tabId] of missed) showUpdatedTab(sessionId, tabId);
    reopen.forEach(requestReveal);
  }, 0);
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
      .catch(() => {});
  };
  window.addEventListener('mixdog:remote-reconnected', resync);
  window.addEventListener('mixdog:remote-state-gap', resync);
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
  return states.get(sessionId) ?? EMPTY;
}

export function useVisualizeState(sessionId: string): VisualizeSessionState {
  return useSyncExternalStore(
    subscribe,
    () => visualizeStateFor(sessionId),
    () => EMPTY
  );
}

/** While a running agent turn holds the session's visualize state back: when
 *  that turn started (ms); else null. */
export function visualizeHeldSince(sessionId: string): number | null {
  return heldStates.has(sessionId) ? (heldSince.get(sessionId) ?? 0) : null;
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

/** True once any session has visualize tabs: the dock toggle appears then. */
export function useVisualizeAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => states.size > 0,
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

/** The panel's header actions. Only Comment and Versions are header buttons
 *  (beside ⋯, expand and close). Every toggle (All visuals, Source, Elements,
 *  Tweaks, Zoom bar) is a checkbox item that leads the ⋯ menu, ahead of the
 *  menu's own items (exports) behind a separator. */
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
  sendActivate(sessionId, tabId);
}

/** A chat card click on a live tab: the user's own request, so it lifts the
 *  user-closed rule, selects the tab and reveals the session's panel. */
export function revealVisualizeTab(sessionId: string, tabId: string): void {
  allowVisualizeReveal(sessionId);
  // A tab a running turn made: the user asked to see it now, so the panel
  // takes what the turn has made so far.
  const held = heldStates.get(sessionId);
  if (held) {
    heldStates = new Map(heldStates);
    heldStates.delete(sessionId);
    heldSince.delete(sessionId);
    setState(held);
  }
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

/** A turn's end opening its confident previews (transcript-visualize-card.tsx),
 *  each file in its own tab, in order, through main's reopen: validated like
 *  an agent open, with its versions, reload watch and "updated" marks, and
 *  brought up by the open policy as an agent open is, so the last one shows.
 *  A panel the user keeps closed stays closed: each open is marked as a
 *  preview's, and whether the panel is closed is asked when that open's
 *  reveal arrives (showUpdatedTab), so a close made at any point while the
 *  opens are pending holds; those opens only make or update their tabs
 *  (their tiles still open them). A file that fails to open is reported and
 *  the rest still open. */
export async function openTurnPreviews(sessionId: string, targets: readonly string[]): Promise<void> {
  for (const target of targets) {
    const request: UserOpen = {
      matches: (tab) => {
        const live = livePanes(tab);
        return live.length === 1 && sameTarget(live[0].target, target);
      },
      expires: Date.now() + USER_OPEN_TTL_MS,
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

/** A tab's live panes (all of them while it shows only a kept version). */
function livePanes(tab: VisualizeTabView): VisualizeTabView['panes'] {
  const current = tab.panes.filter((pane) => pane.version === undefined);
  return current.length ? current : tab.panes;
}

/** A user's request to open the tab `matches` names (`send` sends it): lifts
 *  the user-closed rule. A live tab it names is shown at once and nothing is
 *  sent; else the open that answers it (that exact tab, within
 *  USER_OPEN_TTL_MS) shows the panel. A failed request shows nothing. */
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
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...timeFormatOptions() });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export function closeVisualizeTab(sessionId: string, tabId: string): void {
  void window.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId, action: 'close' })?.catch(() => {});
}

type VisualizeTabState = VisualizeSessionState['tabs'][number];

/** The version stepper's position: the shown version (the newest when live)
 *  and the newest; null while the tab keeps fewer than two versions. */
export function visualizeVersionPosition(tab: Pick<VisualizeTabState, 'versions' | 'version'>): {
  shown: number;
  newest: number;
} | null {
  const list = tab.versions ?? [];
  const newest = list.at(-1)?.n;
  if (newest === undefined || (list.length < 2 && tab.version == null)) return null;
  return { shown: tab.version ?? newest, newest };
}

/** The version one step older (-1) or newer (+1) than the shown one: a kept
 *  version number, null for live (stepping onto the newest), or undefined
 *  when there is none that way. */
export function visualizeVersionStep(
  tab: Pick<VisualizeTabState, 'versions' | 'version'>,
  direction: -1 | 1
): number | null | undefined {
  const list = tab.versions ?? [];
  const position = visualizeVersionPosition(tab);
  if (!position) return undefined;
  const next = list[list.findIndex((version) => version.n === position.shown) + direction];
  if (!next) return undefined;
  return next.n === position.newest ? null : next.n;
}

/** Show kept version `version` (null = back to live), beside live when
 *  `compare`. */
export function showVisualizeVersion(sessionId: string, tabId: string, version: number | null, compare = false): void {
  void window.mixdogDesktop
    ?.visualizeCommand?.({ sessionId, tabId, action: 'version', version, ...(compare ? { compare: true } : {}) })
    ?.catch(() => {});
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

/** Toggle Compare: on from live compares the previous version with live. */
export function toggleVisualizeCompare(sessionId: string, tab: VisualizeTabState): void {
  if (tab.compare) {
    showVisualizeVersion(sessionId, tab.id, tab.version ?? null);
    return;
  }
  const version = tab.version ?? visualizeVersionStep(tab, -1);
  if (typeof version === 'number') showVisualizeVersion(sessionId, tab.id, version, true);
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

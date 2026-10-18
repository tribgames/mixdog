// The agent `visualize` tool's side-panel tabs as the renderer sees them. Main
// owns the state and pushes every change; this store mirrors it per session,
// hands web URLs to the session's browser panel, and relays reveal requests to
// the app shell (which owns the pane docks).
import { useSyncExternalStore } from 'react';

import type {
  DesktopVisualizeEvent,
  VisualizeCommandResult,
  VisualizeInlineContent,
  VisualizeSessionState,
} from '../shared/visualize';
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { linkOpenTarget } from './link-open-target';
import { emitVisualizeZoomInput, emitVisualizeZoomModifier } from './visualize-zoom';

type Listener = () => void;
type RevealListener = (sessionId: string) => void;

const EMPTY: VisualizeSessionState = Object.freeze({ sessionId: '', tabs: [], active: null });

let states = new Map<string, VisualizeSessionState>();
const listeners = new Set<Listener>();
const revealListeners = new Set<RevealListener>();
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
 * visualize panel up on that tab, on the desktop and on a paired phone alike
 * — unless the panel is on screen showing another tab the user picked
 * themselves; then the tab only gets an "updated" mark until it is viewed.
 * A pick lasts while the panel stays on screen; once it leaves (closed,
 * another dock view, another session) the next open or update takes over.
 */
/** Sessions whose visualize panel is on screen right now (VisualizePane). */
const onScreen = new Set<string>();
/** The tab the user picked in a session's panel (strip, chat card). */
const userPicks = new Map<string, string>();
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
  updatedTabs = new Map();
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
  states = next;
  emit();
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
  if (event.openUrl) requestBrowserPage(sessionId, event.openUrl, { newTab: true, agent: true });
  const state = event.state ? { ...event.state, sessionId } : undefined;
  // An agent open or a content update carries `reveal` (and, from current
  // hosts, the tab it was for): the open policy decides what shows.
  if (event.reveal) showUpdatedTab(sessionId, event.tab || state?.active || '', state);
  else if (state) setState(state);
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

/** Apply the open policy to an open or update of `tabId` (`incoming`: the
 *  state that came with it). Shown: the tab becomes active (main told when it
 *  did not pick it itself, as for a file-change update) and the panel is
 *  revealed, lifting a user close. Kept: the user's tab stays (main told
 *  again when the open moved it) and `tabId` is marked updated. */
function showUpdatedTab(sessionId: string, tabId: string, incoming?: VisualizeSessionState): void {
  const base = incoming ?? states.get(sessionId);
  if (!base) return;
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
  if (shown) onScreen.add(sessionId);
  else {
    onScreen.delete(sessionId);
    userPicks.delete(sessionId);
  }
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
      next.set(state.sessionId, shareSession(states.get(state.sessionId), state));
    }
  }
  const same = next.size === states.size && [...next].every(([id, state]) => states.get(id) === state);
  if (!same) {
    states = next;
    emit();
  }
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
  activateVisualizeTab(sessionId, tabId);
  requestReveal(sessionId);
}

/** A chat card click on a closed tab: open the same file targets again (no
 *  agent turn); main's open then reveals the panel, which the click allowed. */
export function reopenVisualizeTargets(sessionId: string, tabId: string, targets: string[], label = ''): Promise<void> {
  allowVisualizeReveal(sessionId);
  return (
    window.mixdogDesktop
      ?.visualizeCommand?.({
        sessionId,
        tabId,
        action: 'reopen',
        targets,
        ...(label ? { label } : {}),
      })
      ?.then(() => undefined) ?? Promise.resolve()
  );
}

/** The same for a closed inline tab: open its stored content again. */
export function reopenVisualizeContent(
  sessionId: string,
  tabId: string,
  content: VisualizeInlineContent,
  label = ''
): Promise<void> {
  allowVisualizeReveal(sessionId);
  return (
    window.mixdogDesktop
      ?.visualizeCommand?.({ sessionId, tabId, action: 'reopen', targets: [], content, ...(label ? { label } : {}) })
      ?.then(() => undefined) ?? Promise.resolve()
  );
}

/** "All visuals": select history entry `entry`'s open tab, or open it again
 *  when closed (no agent turn). The user's own request, so it lifts the
 *  user-closed rule like a chat card press. */
export function openVisualizeHistory(sessionId: string, entry: string): Promise<void> {
  allowVisualizeReveal(sessionId);
  return (
    window.mixdogDesktop
      ?.visualizeCommand?.({ sessionId, tabId: '', action: 'history', entry })
      .then(() => undefined) ?? Promise.resolve()
  );
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
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

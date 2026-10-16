// The agent `visualize` tool's side-panel tabs as the renderer sees them. Main
// owns the state and pushes every change; this store mirrors it per session,
// hands web URLs to the session's browser panel, and relays reveal requests to
// the app shell (which owns the pane docks).
import { useSyncExternalStore } from 'react';

import type { DesktopVisualizeEvent, VisualizeCommandResult, VisualizeSessionState } from '../shared/visualize';
import { requestBrowserPage } from './browser-page-request';

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

/** Per-session panel memory, kept in sessionStorage so it survives a renderer
 *  reload (main keeps the tabs; the renderer forgets which panels it showed).
 *  `open`: the panel was on screen and not closed by the user since.
 *  `closed`: the user closed it — file-change reloads and updates keep
 *  updating the tabs without revealing the panel, and a renderer reload does
 *  not bring it back; a new agent `open` (or the user) lifts the mark. */
const PANEL_MEMORY_KEY = 'mixdog.visualize.panels.v1';
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
    const parsed = JSON.parse(globalThis.sessionStorage?.getItem(PANEL_MEMORY_KEY) ?? '{}');
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
    globalThis.sessionStorage?.setItem(
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

/** Apply one main-process event (exported for tests). */
export function applyVisualizeEvent(event: DesktopVisualizeEvent): void {
  const sessionId = String(event?.sessionId || '');
  if (!sessionId) return;
  if (event.openUrl) requestBrowserPage(sessionId, event.openUrl, { newTab: true, agent: true });
  if (event.state) setState({ ...event.state, sessionId });
  // Only an agent open carries `reveal`: it is a fresh request to show the
  // panel, so it lifts a user close. Reloads and updates never reveal.
  if (event.reveal) {
    allowVisualizeReveal(sessionId);
    requestReveal(sessionId);
  }
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
    const memory = panelMemory();
    if (state.tabs.length && memory.open.has(state.sessionId) && !memory.closed.has(state.sessionId)) {
      reopen.push(state.sessionId);
    }
  }
  if (changed) {
    states = next;
    emit();
  }
  if (reopen.length) setTimeout(() => reopen.forEach(requestReveal), 0);
}

/** A paired remote client back from a gap (exported for tests): pushes may
 *  have been missed while the link was down, so the host's snapshot replaces
 *  every session's tabs. Nothing is revealed. */
export function resyncVisualizeStates(snapshot: readonly VisualizeSessionState[] | null | undefined): void {
  const next = new Map<string, VisualizeSessionState>();
  for (const state of snapshot ?? []) {
    if (state?.sessionId && (state.tabs.length || state.history?.length)) {
      next.set(state.sessionId, shareSession(states.get(state.sessionId), state));
    }
  }
  const same = next.size === states.size && [...next].every(([id, state]) => states.get(id) === state);
  if (same) return;
  states = next;
  emit();
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

/** The user closed the panel: later agent opens stay quiet for this session,
 *  and a renderer reload does not bring it back. */
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
export const VISUALIZE_SIDE_BY_SIDE_MIN_WIDTH = 2 * 360;

export function visualizePanesStacked(bodyWidth: number, paneCount: number): boolean {
  return paneCount > 1 && bodyWidth > 0 && bodyWidth < VISUALIZE_SIDE_BY_SIDE_MIN_WIDTH;
}

/** Below this panel width the header keeps only Comment and Tweaks as
 *  buttons (beside ⋯, expand and close); the other toolbar toggles become
 *  ⋯ items so the tab strip keeps room for the active tab's label. */
export const VISUALIZE_HEADER_FOLD_WIDTH = 520;
const VISUALIZE_HEADER_PINNED: ReadonlySet<string> = new Set(['comment', 'tweaks', 'versions']);

interface VisualizeHeaderAction {
  id: string;
  inline?: boolean;
  checked?: boolean;
  checkbox?: boolean;
  separatorBefore?: boolean;
}

/** The panel's header actions at `panelWidth` (0 = unmeasured: as wide).
 *  Folded toggles lead the ⋯ menu as checkbox items, ahead of the menu's
 *  own items (exports) behind a separator; attention and badges ride along. */
export function visualizeHeaderActions<T extends VisualizeHeaderAction>(
  actions: readonly T[],
  panelWidth: number
): T[] {
  if (!(panelWidth > 0 && panelWidth < VISUALIZE_HEADER_FOLD_WIDTH)) return [...actions];
  const folds = (action: T) => Boolean(action.inline) && !VISUALIZE_HEADER_PINNED.has(action.id);
  const folded = actions
    .filter(folds)
    .map((action) => ({ ...action, inline: false, ...(action.checked === undefined ? {} : { checkbox: true }) }));
  const menu = actions.filter((action) => !action.inline);
  return [
    ...actions.filter((action) => action.inline && !folds(action)),
    ...folded,
    ...menu.map((action, index) => (index === 0 && folded.length ? { ...action, separatorBefore: true } : action)),
  ];
}

/** A tab's tooltip: its full label, then every target it shows. */
export function visualizeTabTooltip(tab: Pick<VisualizeSessionState['tabs'][number], 'label' | 'panes'>): string {
  return [tab.label, ...tab.panes.map((pane) => pane.target)].join('\n');
}

export function activateVisualizeTab(sessionId: string, tabId: string): void {
  const state = states.get(sessionId);
  if (state && state.active !== tabId) setState({ ...state, active: tabId });
  void window.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId, action: 'activate' })?.catch(() => {});
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

/** Allow (or block again) outside network for a tab's HTML pages; the tab
 *  reloads under the new policy. Desktop only. */
export function setVisualizeNetwork(sessionId: string, tabId: string, allow: boolean): void {
  void window.mixdogDesktop?.visualizeCommand?.({ sessionId, tabId, action: 'network', allow })?.catch(() => {});
}

/** Tabs whose pages the user chose to run on this paired remote client,
 *  remembered for this device session (the page's lifetime). */
const scriptRuns = new Set<string>();
const scriptRunKey = (sessionId: string, tabId: string) => `${sessionId}\0${tabId}`;

/** The user tapped "Run" on a page that runs scripts: only a trusted
 *  (user-made) event counts. Returns whether it was accepted. */
export function allowVisualizeScripts(sessionId: string, tabId: string, event: { isTrusted?: boolean }): boolean {
  if (event.isTrusted !== true) return false;
  scriptRuns.add(scriptRunKey(sessionId, tabId));
  emit();
  return true;
}

export function visualizeScriptsAllowed(sessionId: string, tabId: string): boolean {
  return scriptRuns.has(scriptRunKey(sessionId, tabId));
}

export function useVisualizeScriptsAllowed(sessionId: string, tabId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => visualizeScriptsAllowed(sessionId, tabId),
    () => false
  );
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
  // Only panes of the desktop window carry an id; remote clients render locally.
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

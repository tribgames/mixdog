// Per-session terminal tab state. The first tab keeps the session's original
// terminal id; later tabs are `<first>:<n>` with n = 2, 3, … never reused
// within a session. Open tabs, their shells and the active tab persist in
// localStorage, like the other per-session pane preferences.

export interface SessionTerminalTab {
  id: string;
  n: number;
  /** Shell profile id the tab's PTY spawns with; '' is the OS default. */
  shell: string;
  /** Execution root the tab's PTY was opened in. A tab never changes root: a
   *  workspace move opens a new tab instead of reusing this PTY. Absent only
   *  until the tab is first bound. */
  cwd?: string;
}

export interface SessionTerminalTabsState {
  tabs: readonly SessionTerminalTab[];
  activeId: string;
  nextN: number;
}

const STORAGE_KEY = 'mixdog.desktop-terminal-tabs.v1';

/** The terminal a conversation session owns in its side dock (its first tab). */
export const sessionTerminalId = (sessionId: string): string => `session-terminal:${sessionId}`;

export const sessionTerminalTabId = (sessionId: string, n: number): string =>
  n === 1 ? sessionTerminalId(sessionId) : `${sessionTerminalId(sessionId)}:${n}`;

const states = new Map<string, SessionTerminalTabsState>();
const listeners = new Set<() => void>();

function readStored(): Record<string, unknown> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function persist(sessionId: string, state: SessionTerminalTabsState | null): void {
  try {
    const stored = readStored();
    if (state) stored[sessionId] = state;
    else delete stored[sessionId];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // The in-memory tabs still apply for this renderer session.
  }
}

function initialState(sessionId: string): SessionTerminalTabsState {
  const id = sessionTerminalTabId(sessionId, 1);
  return { tabs: [{ id, n: 1, shell: '' }], activeId: id, nextN: 2 };
}

function parseState(sessionId: string, raw: unknown): SessionTerminalTabsState | null {
  const value = raw as Partial<SessionTerminalTabsState> | null;
  if (!value || !Array.isArray(value.tabs)) return null;
  const tabs: SessionTerminalTab[] = [];
  for (const item of value.tabs as Partial<SessionTerminalTab>[]) {
    const n = item?.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || tabs.some((tab) => tab.n === n)) return null;
    tabs.push({
      id: sessionTerminalTabId(sessionId, n),
      n,
      shell: typeof item.shell === 'string' ? item.shell : '',
      ...(typeof item.cwd === 'string' && item.cwd ? { cwd: item.cwd } : {}),
    });
  }
  const activeId = tabs.some((tab) => tab.id === value.activeId) ? (value.activeId as string) : (tabs[0]?.id ?? '');
  const nextN = Math.max(
    2,
    Number.isInteger(value.nextN) ? (value.nextN as number) : 0,
    ...tabs.map((tab) => tab.n + 1)
  );
  return { tabs, activeId, nextN };
}

export function getSessionTerminalTabs(sessionId: string): SessionTerminalTabsState {
  let state = states.get(sessionId);
  if (!state) {
    state = parseState(sessionId, readStored()[sessionId]) ?? initialState(sessionId);
    states.set(sessionId, state);
  }
  return state;
}

function commit(sessionId: string, state: SessionTerminalTabsState): void {
  states.set(sessionId, state);
  persist(sessionId, state);
  for (const listener of [...listeners]) listener();
}

export function subscribeSessionTerminalTabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The tab that currently receives terminal command requests. */
export const activeSessionTerminalId = (sessionId: string): string => getSessionTerminalTabs(sessionId).activeId;

/** Open a new tab with `shell` ('' = OS default) and make it active. */
export function openSessionTerminalTab(sessionId: string, shell = '', cwd = ''): SessionTerminalTab {
  const state = getSessionTerminalTabs(sessionId);
  const tab: SessionTerminalTab = {
    id: sessionTerminalTabId(sessionId, state.nextN),
    n: state.nextN,
    shell,
    ...(cwd ? { cwd } : {}),
  };
  commit(sessionId, { tabs: [...state.tabs, tab], activeId: tab.id, nextN: state.nextN + 1 });
  return tab;
}

/** Build this device's tab list from the terminals main runs for the session:
 *  a listed terminal this device lacks gets a tab (in main's root, default
 *  shell); tabs without a process yet stay, they start when shown. The active
 *  tab is left alone — the caller selects the one it wants. */
export function adoptSessionTerminalTabs(
  sessionId: string,
  listed: readonly { id: string; tab: number; cwd?: string | null }[]
): void {
  const state = getSessionTerminalTabs(sessionId);
  const added: SessionTerminalTab[] = [];
  for (const entry of listed) {
    const n = entry.tab;
    if (!Number.isInteger(n) || n < 1 || entry.id !== sessionTerminalTabId(sessionId, n)) continue;
    if (state.tabs.some((tab) => tab.n === n) || added.some((tab) => tab.n === n)) continue;
    added.push({ id: entry.id, n, shell: '', ...(entry.cwd ? { cwd: entry.cwd } : {}) });
  }
  if (!added.length) return;
  const tabs = [...state.tabs, ...added].sort((a, b) => a.n - b.n);
  commit(sessionId, {
    tabs,
    activeId: tabs.some((tab) => tab.id === state.activeId) ? state.activeId : tabs[0].id,
    nextN: Math.max(state.nextN, ...tabs.map((tab) => tab.n + 1)),
  });
}

export function selectSessionTerminalTab(sessionId: string, id: string): void {
  const state = getSessionTerminalTabs(sessionId);
  if (state.activeId === id || !state.tabs.some((tab) => tab.id === id)) return;
  commit(sessionId, { ...state, activeId: id });
}

/** Remove a tab; closing the last one leaves no tabs (the caller closes the
 *  side panel; the next open creates a fresh tab). Returns the
 *  closed terminal id (to dispose), or null when `id` is not a tab. */
export function closeSessionTerminalTab(sessionId: string, id: string): string | null {
  const state = getSessionTerminalTabs(sessionId);
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return null;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId = state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? '') : state.activeId;
  commit(sessionId, { tabs, activeId, nextN: state.nextN });
  return id;
}

/** A session-bound terminal runs in the session workspace's execution root,
 *  falling back to the pane's project path. */
export const resolveTerminalCwd = (workspaceCwd: string | null | undefined, projectPath: string | null | undefined) =>
  workspaceCwd || projectPath || null;

const sameRoot = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

/** Follow the session's execution root. Unbound tabs adopt `cwd`; when the root
 *  moved, the tab already open in that root is selected, else a NEW tab opens
 *  there. Existing tabs and their PTYs are never re-rooted or sent `cd`. */
export function followSessionTerminalRoot(sessionId: string, cwd: string | null, reselect = true): void {
  const state = getSessionTerminalTabs(sessionId);
  // A closed terminal stays closed until it is explicitly reopened.
  if (!cwd || !state.tabs.length) return;
  if (state.tabs.some((tab) => !tab.cwd)) {
    commit(sessionId, { ...state, tabs: state.tabs.map((tab) => (tab.cwd ? tab : { ...tab, cwd })) });
  }
  const current = getSessionTerminalTabs(sessionId);
  const match = current.tabs.find((tab) => tab.cwd && sameRoot(tab.cwd, cwd));
  if (match) {
    if (reselect) selectSessionTerminalTab(sessionId, match.id);
  } else openSessionTerminalTab(sessionId, '', cwd);
}

/** Last path segment, shown on a tab whose root differs from its siblings'. */
export const terminalRootLabel = (cwd: string): string =>
  cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || cwd;

/** Forget a released session's tabs; returns every terminal id to dispose. */
export function releaseSessionTerminalTabs(sessionId: string): string[] {
  const ids = getSessionTerminalTabs(sessionId).tabs.map((tab) => tab.id);
  states.delete(sessionId);
  persist(sessionId, null);
  return ids;
}

// Per-session terminal tab state. The first tab keeps the session's original
// terminal id; later tabs are `<first>:<n>` with n = 2, 3, … never reused
// within a session. Open tabs, their shells and the active tab persist in
// localStorage, like the other per-session pane preferences.

export interface SessionTerminalTab {
  id: string;
  n: number;
  /** Shell profile id the tab's PTY spawns with; '' is the OS default. */
  shell: string;
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
  if (!value || !Array.isArray(value.tabs) || !value.tabs.length) return null;
  const tabs: SessionTerminalTab[] = [];
  for (const item of value.tabs as Partial<SessionTerminalTab>[]) {
    const n = item?.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || tabs.some((tab) => tab.n === n)) return null;
    tabs.push({ id: sessionTerminalTabId(sessionId, n), n, shell: typeof item.shell === 'string' ? item.shell : '' });
  }
  const activeId = tabs.some((tab) => tab.id === value.activeId) ? (value.activeId as string) : tabs[0].id;
  const nextN = Math.max(Number.isInteger(value.nextN) ? (value.nextN as number) : 0, ...tabs.map((tab) => tab.n + 1));
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
export function openSessionTerminalTab(sessionId: string, shell = ''): SessionTerminalTab {
  const state = getSessionTerminalTabs(sessionId);
  const tab: SessionTerminalTab = { id: sessionTerminalTabId(sessionId, state.nextN), n: state.nextN, shell };
  commit(sessionId, { tabs: [...state.tabs, tab], activeId: tab.id, nextN: state.nextN + 1 });
  return tab;
}

export function selectSessionTerminalTab(sessionId: string, id: string): void {
  const state = getSessionTerminalTabs(sessionId);
  if (state.activeId === id || !state.tabs.some((tab) => tab.id === id)) return;
  commit(sessionId, { ...state, activeId: id });
}

/** Remove a tab; closing the last one leaves a fresh default tab. Returns the
 *  closed terminal id (to dispose), or null when `id` is not a tab. */
export function closeSessionTerminalTab(sessionId: string, id: string): string | null {
  const state = getSessionTerminalTabs(sessionId);
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return null;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  let { nextN } = state;
  if (!tabs.length) {
    tabs.push({ id: sessionTerminalTabId(sessionId, nextN), n: nextN, shell: '' });
    nextN += 1;
  }
  const activeId =
    state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)] ?? tabs[0]).id : state.activeId;
  commit(sessionId, { tabs, activeId, nextN });
  return id;
}

/** Forget a released session's tabs; returns every terminal id to dispose. */
export function releaseSessionTerminalTabs(sessionId: string): string[] {
  const ids = getSessionTerminalTabs(sessionId).tabs.map((tab) => tab.id);
  states.delete(sessionId);
  persist(sessionId, null);
  return ids;
}

// A shell command the transcript asks a session's terminal to run (a code
// block's Run), and the reveal of a terminal the agent already ran a command in.
// Like a browser page request, a Run crosses two owners: the app shell reveals
// the session's terminal dock, and the terminal pane enters the command once its
// PTY is attached. A command sent before that pane exists waits here. The
// agent's runs need no pane: main starts the process and only reveals its tab.

import {
  type DesktopTerminalRunRequest,
  TERMINAL_SHOWN_WAIT_MS,
  terminalCommandInput,
} from '../shared/terminal-command';
import {
  activeSessionTerminalId,
  adoptSessionTerminalTabs,
  openSessionTerminalTab,
  selectSessionTerminalTab,
  sessionTerminalId,
} from './session-terminal-tabs';

type RevealListener = (sessionId: string) => void;
type InputListener = (input: string) => void;

const revealListeners = new Set<RevealListener>();
const availabilityListeners = new Set<() => void>();
const inputListeners = new Map<string, Set<InputListener>>();
interface QueuedInput {
  input: string;
}
const pendingInput = new Map<string, QueuedInput[]>();

// Terminals a pane is showing right now (an active TerminalPane).
const shownTerminals = new Map<string, number>();
const shownListeners = new Set<() => void>();

/** A pane shows `terminalId` until the returned function is called. */
export function markTerminalShown(terminalId: string): () => void {
  shownTerminals.set(terminalId, (shownTerminals.get(terminalId) ?? 0) + 1);
  for (const listener of [...shownListeners]) listener();
  return () => {
    const count = (shownTerminals.get(terminalId) ?? 0) - 1;
    if (count > 0) shownTerminals.set(terminalId, count);
    else shownTerminals.delete(terminalId);
  };
}

/** Resolves true once a pane shows `terminalId`; false after `timeoutMs`. */
function terminalShownWithin(terminalId: string, timeoutMs: number): Promise<boolean> {
  if (shownTerminals.has(terminalId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (shown: boolean) => {
      window.clearTimeout(timer);
      shownListeners.delete(check);
      resolve(shown);
    };
    const check = () => {
      if (shownTerminals.has(terminalId)) finish(true);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    shownListeners.add(check);
  });
}

export { sessionTerminalId };

/** True while a shell that can reveal a session terminal is mounted. */
export function terminalCommandRequestsAvailable(): boolean {
  return revealListeners.size > 0;
}

export function onTerminalCommandAvailabilityChanged(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

function notifyAvailabilityChanged(): void {
  for (const listener of availabilityListeners) listener();
}

export { terminalCommandInput };

/** Select a session's terminal tab and reveal its dock. `tabs` is main's list
 *  of the session's terminals; the tab list is built from it, so the tab
 *  exists on this device (a phone, a second window) before it is selected. */
export function revealSessionTerminalTab(
  sessionId: string,
  terminalId?: string,
  tabs?: DesktopTerminalRunRequest['tabs']
): void {
  if (!sessionId) return;
  // Without main's list (a transcript card), the terminal's own id names its tab.
  const base = sessionTerminalId(sessionId);
  const own = terminalId
    ? [{ id: terminalId, tab: terminalId === base ? 1 : Number(terminalId.slice(base.length + 1)) }]
    : [];
  adoptSessionTerminalTabs(sessionId, tabs ?? own);
  if (terminalId) selectSessionTerminalTab(sessionId, terminalId);
  for (const listener of revealListeners) listener(sessionId);
}

/** The agent's `terminal` tool ran a command in a terminal main already
 *  started: select its tab and reveal the dock. With a `requestId` (the
 *  desktop window) main is told once a pane really shows that terminal. */
export function handleTerminalRunRequest({ sessionId, terminalId, tabs, requestId }: DesktopTerminalRunRequest): void {
  revealSessionTerminalTab(sessionId, terminalId, tabs);
  if (!requestId || !terminalId) return;
  void terminalShownWithin(terminalId, TERMINAL_SHOWN_WAIT_MS).then((shown) => {
    if (shown) void window.mixdogDesktop?.claimTerminalRun?.(requestId);
  });
}

function deliverInput(entry: QueuedInput, listeners: Iterable<InputListener>): void {
  for (const listener of [...listeners]) listener(entry.input);
}

export function requestTerminalCommand(sessionId: string, command: string): void {
  if (!sessionId || !command.trim()) return;
  const terminalId = activeSessionTerminalId(sessionId) || openSessionTerminalTab(sessionId).id;
  const entry: QueuedInput = { input: terminalCommandInput(command) };
  const listeners = inputListeners.get(terminalId);
  if (listeners?.size) deliverInput(entry, listeners);
  else pendingInput.set(terminalId, [...(pendingInput.get(terminalId) || []), entry]);
  for (const listener of revealListeners) listener(sessionId);
}

export function onTerminalRevealRequested(listener: RevealListener): () => void {
  const wasAvailable = terminalCommandRequestsAvailable();
  revealListeners.add(listener);
  if (!wasAvailable) notifyAvailabilityChanged();
  return () => {
    if (revealListeners.delete(listener) && !terminalCommandRequestsAvailable()) notifyAvailabilityChanged();
  };
}

/** Subscribe a terminal to command input; input requested before the
 *  terminal was ready is delivered at once, in order. */
export function onTerminalCommandRequested(terminalId: string, listener: InputListener): () => void {
  let listeners = inputListeners.get(terminalId);
  if (!listeners) {
    listeners = new Set();
    inputListeners.set(terminalId, listeners);
  }
  listeners.add(listener);
  const pending = pendingInput.get(terminalId);
  if (pending) {
    pendingInput.delete(terminalId);
    for (const entry of pending) deliverInput(entry, [listener]);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) inputListeners.delete(terminalId);
  };
}

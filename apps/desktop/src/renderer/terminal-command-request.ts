// A shell command the transcript asks a session's terminal to run. Like a
// browser page request, it crosses two owners: the app shell reveals the
// session's terminal dock, and the terminal pane enters the command once its
// PTY is attached. A command sent before that pane exists waits here.

import { activeSessionTerminalId, sessionTerminalId } from './session-terminal-tabs';

type RevealListener = (sessionId: string) => void;
type InputListener = (input: string) => void;

const revealListeners = new Set<RevealListener>();
const availabilityListeners = new Set<() => void>();
const inputListeners = new Map<string, Set<InputListener>>();
const pendingInput = new Map<string, string[]>();

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

/** Terminal input that runs `command`, entering each line in turn. */
export function terminalCommandInput(command: string): string {
  return `${command.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r')}\r`;
}

export function requestTerminalCommand(sessionId: string, command: string): void {
  if (!sessionId || !command.trim()) return;
  const terminalId = activeSessionTerminalId(sessionId);
  const input = terminalCommandInput(command);
  const listeners = inputListeners.get(terminalId);
  if (listeners?.size) {
    for (const listener of listeners) listener(input);
  } else {
    pendingInput.set(terminalId, [...(pendingInput.get(terminalId) || []), input]);
  }
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
    for (const input of pending) listener(input);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) inputListeners.delete(terminalId);
  };
}

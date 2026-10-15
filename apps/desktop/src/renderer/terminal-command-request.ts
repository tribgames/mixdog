// A shell command the transcript asks a session's terminal to run. Like a
// browser page request, it crosses two owners: the app shell reveals the
// session's terminal dock, and the terminal pane enters the command once its
// PTY is attached. A command sent before that pane exists waits here.

import { type DesktopTerminalRunRequest, terminalCommandInput } from '../shared/terminal-command';
import { activeSessionTerminalId, openSessionTerminalTab, sessionTerminalId } from './session-terminal-tabs';

type RevealListener = (sessionId: string) => void;
type InputListener = (input: string) => void;

const revealListeners = new Set<RevealListener>();
const availabilityListeners = new Set<() => void>();
const inputListeners = new Map<string, Set<InputListener>>();
/** Whether the input may still run: the agent's request resolves false once the
 *  tool call gave up, so a command reported as failed is never entered later. */
type ClaimInput = () => Promise<boolean>;
interface QueuedInput {
  input: string;
  requestId?: string;
  claim?: ClaimInput;
}
const pendingInput = new Map<string, QueuedInput[]>();

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

/** The agent's `terminal` tool ran (or wants to run) a command in a session's
 *  terminal: reveal its dock, and with a `command` open/use a tab to enter it. */
export function handleTerminalRunRequest({
  sessionId,
  command,
  requestId,
  cancelRequestId,
}: DesktopTerminalRunRequest): void {
  if (cancelRequestId) cancelTerminalCommand(cancelRequestId);
  else if (command) {
    // The main process only lets an input through while its tool call still
    // waits: it answers the claim at the moment the terminal would enter it.
    const claim: ClaimInput | undefined = requestId
      ? async () => (await window.mixdogDesktop?.claimTerminalRun?.(requestId)) === true
      : undefined;
    requestTerminalCommand(sessionId, command, requestId, claim);
  } else if (sessionId) for (const listener of revealListeners) listener(sessionId);
}

/** Drop the queued input of a request the agent gave up on. */
export function cancelTerminalCommand(requestId: string): void {
  for (const [terminalId, queue] of pendingInput) {
    const kept = queue.filter((entry) => entry.requestId !== requestId);
    if (kept.length) pendingInput.set(terminalId, kept);
    else pendingInput.delete(terminalId);
  }
}

async function deliverInput(entry: QueuedInput, listeners: Iterable<InputListener>): Promise<void> {
  if (entry.claim && !(await entry.claim().catch(() => false))) return;
  for (const listener of [...listeners]) listener(entry.input);
}

export function requestTerminalCommand(
  sessionId: string,
  command: string,
  requestId?: string,
  claim?: ClaimInput
): void {
  if (!sessionId || !command.trim()) return;
  const terminalId = activeSessionTerminalId(sessionId) || openSessionTerminalTab(sessionId).id;
  const entry: QueuedInput = { input: terminalCommandInput(command), requestId, claim };
  const listeners = inputListeners.get(terminalId);
  if (listeners?.size) void deliverInput(entry, listeners);
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
    for (const entry of pending) void deliverInput(entry, [listener]);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) inputListeners.delete(terminalId);
  };
}

// Per-terminal command activity. A shell Mixdog spawned with its own
// integration reports prompts and finished commands as private OSC markers;
// the daemon turns them into one state per PTY. A shell without integration
// never reports, and its state stays unknown (`null`): no tab dot.

/** `finished`: a command completed while no view had the tab focused; the
 *  next focus clears it back to `idle`. */
export type TerminalActivityState = 'idle' | 'running' | 'finished';

export interface TerminalActivityEvent {
  id: string;
  /** null = unknown (no integration, or the shell exited). */
  state: TerminalActivityState | null;
}

export const TERMINAL_ACTIVITY_EVENT = 'terminal-activity';

/** A view's focus claim lapses unless renewed, so a closed window or a phone
 *  that went away cannot keep a tab "focused" forever. */
export const TERMINAL_FOCUS_LEASE_MS = 30_000;
export const TERMINAL_FOCUS_RENEW_MS = 10_000;

const STATES = new Set<string>(['idle', 'running', 'finished']);

/** Validate one activity event off any transport; null when malformed. */
export function readTerminalActivityEvent(value: unknown): TerminalActivityEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  const id = typeof event.id === 'string' ? event.id : '';
  if (!id) return null;
  const state =
    typeof event.state === 'string' && STATES.has(event.state) ? (event.state as TerminalActivityState) : null;
  return { id, state };
}

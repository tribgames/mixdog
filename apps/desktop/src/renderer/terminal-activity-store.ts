// Renderer mirror of the host's per-terminal command activity, plus this
// view's focus reports. A terminal the host never reported is unknown and
// shows no dot.
import {
  TERMINAL_FOCUS_RENEW_MS,
  type TerminalActivityEvent,
  type TerminalActivityState,
} from '../shared/terminal-activity';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';

let states = new Map<string, TerminalActivityState>();
const listeners = new Set<() => void>();
const focusCounts = new Map<string, number>();
let renewTimer: ReturnType<typeof setInterval> | null = null;
let detach: (() => void) | null = null;
/** Bumped by every snapshot request; only the newest one may apply. */
let refreshGeneration = 0;
/** Events pushed while a snapshot request is outstanding, newest per id:
 *  they are at least as new as anything that snapshot can contain. */
let pushedDuringRefresh: Map<string, TerminalActivityState | null> | null = null;
/** Events after which the host's list must be read again: window refocus, a
 *  remote connection becoming ready, and the remote recovery signals. */
const REFRESH_EVENTS = [
  'focus',
  REMOTE_CONNECTION_READY_EVENT,
  'mixdog:remote-reconnected',
  'mixdog:remote-state-gap',
] as const;

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Apply one host event (exported for tests). */
export function applyTerminalActivity(event: TerminalActivityEvent): void {
  pushedDuringRefresh?.set(event.id, event.state);
  const previous = states.get(event.id) ?? null;
  if (previous === event.state) return;
  const next = new Map(states);
  if (event.state) next.set(event.id, event.state);
  else next.delete(event.id);
  states = next;
  notify();
  // A tab this view shows focused never stays "finished" (its lease may have
  // lapsed while the timers were throttled): claim it again.
  if (event.state === 'finished' && focusCounts.has(event.id)) window.mixdogDesktop?.termFocus?.(event.id, true);
}

/** Replace everything with the host's current list (a later entry for the
 *  same id wins; a null state removes it). */
export function applyTerminalActivitySnapshot(events: readonly TerminalActivityEvent[]): void {
  const next = new Map<string, TerminalActivityState>();
  for (const event of events) {
    if (event.state) next.set(event.id, event.state);
    else next.delete(event.id);
  }
  states = next;
  notify();
}

/** Read the host's list. A response is dropped when a newer request was made
 *  meanwhile, and events pushed while it was loading override it. */
const refresh = (): void => {
  const read = window.mixdogDesktop?.termActivity;
  if (!read) return;
  const generation = ++refreshGeneration;
  // Pushes before this request are older than its snapshot.
  pushedDuringRefresh = new Map();
  const settle = (events: readonly TerminalActivityEvent[] | null): void => {
    if (generation !== refreshGeneration) return;
    const pushed = pushedDuringRefresh ?? new Map();
    pushedDuringRefresh = null;
    if (!events) return;
    applyTerminalActivitySnapshot([...events, ...[...pushed].map(([id, state]) => ({ id, state }))]);
  };
  read()
    .then((events) => settle(Array.isArray(events) ? events : []))
    .catch(() => settle(null));
};

export function subscribeTerminalActivity(listener: () => void): () => void {
  listeners.add(listener);
  if (!detach) {
    const unsubscribe = window.mixdogDesktop?.subscribeTermActivity?.(applyTerminalActivity) ?? (() => {});
    // Events missed while disconnected or reloading are recovered here.
    for (const name of REFRESH_EVENTS) window.addEventListener(name, refresh);
    detach = () => {
      unsubscribe();
      for (const name of REFRESH_EVENTS) window.removeEventListener(name, refresh);
      refreshGeneration += 1;
      pushedDuringRefresh = null;
    };
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

/** Immutable per change, so it serves as a useSyncExternalStore snapshot. */
export const getTerminalActivityStates = (): ReadonlyMap<string, TerminalActivityState> => states;

const renewFocus = (): void => {
  for (const id of focusCounts.keys()) window.mixdogDesktop?.termFocus?.(id, true);
};

/** This view shows terminal `id` focused; the returned function ends that.
 *  The host lease is renewed while any focus is held. */
export function holdTerminalFocus(id: string): () => void {
  const count = focusCounts.get(id) ?? 0;
  focusCounts.set(id, count + 1);
  if (count === 0) window.mixdogDesktop?.termFocus?.(id, true);
  renewTimer ??= setInterval(renewFocus, TERMINAL_FOCUS_RENEW_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (focusCounts.get(id) ?? 1) - 1;
    if (left > 0) {
      focusCounts.set(id, left);
      return;
    }
    focusCounts.delete(id);
    window.mixdogDesktop?.termFocus?.(id, false);
    if (focusCounts.size === 0 && renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  };
}

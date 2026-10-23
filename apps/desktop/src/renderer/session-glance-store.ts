// What a bot's chat shows of the OTHER session it talks to (its "sent to"
// line, its folded answer): the session's current title and whether the
// daemon runs a turn of it. Fed by the session catalog (app-session-catalog.ts),
// so a rename and a turn's end reach the chat without any polling.
import { useSyncExternalStore } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionDisplayTitle } from './session-display-title';

export interface SessionGlance {
  title: string;
  preview: string;
  working: boolean;
}

let glances: ReadonlyMap<string, SessionGlance> = new Map();
const listeners = new Set<() => void>();

/** Take the titles and run states of a fresh catalog; listeners hear only real changes. */
export function publishSessionGlances(
  sessions: readonly Pick<DesktopSessionSummary, 'id' | 'title' | 'preview' | 'working'>[]
): void {
  const next = new Map<string, SessionGlance>();
  let changed = false;
  for (const session of sessions) {
    const title = session.title || '';
    const preview = session.preview || '';
    const working = session.working === true;
    const previous = glances.get(session.id);
    if (previous && previous.title === title && previous.preview === preview && previous.working === working) {
      next.set(session.id, previous);
    } else {
      next.set(session.id, { title, preview, working });
      changed = true;
    }
  }
  if (!changed && next.size === glances.size) return;
  glances = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `sessionId`'s title and run state; null when the catalog does not hold it. */
export function useSessionGlance(sessionId: string): SessionGlance | null {
  const read = () => glances.get(sessionId) ?? null;
  return useSyncExternalStore(subscribe, read, read);
}

/** The title to show for `sessionId` (its current one, else `fallback`). */
export function useSessionTitle(sessionId: string, fallback: string): string {
  return sessionDisplayTitle(useSessionGlance(sessionId), fallback);
}

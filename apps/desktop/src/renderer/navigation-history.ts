/** The window's Back/Forward history (issue #289): session visits and editor
 *  locations in visit order. One linear stack per window, in memory only; a
 *  new visit truncates forward history. */
import { isAgentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { WorkspaceSelection } from './navigation';

export interface EditorNavigationLocation {
  project: string;
  rel: string;
  line: number;
  accessToken?: string;
}

export type NavigationHistoryEntry =
  | { kind: 'session'; id: string }
  | { kind: 'editor'; location: EditorNavigationLocation };

export interface NavigationHistory {
  entries: NavigationHistoryEntry[];
  index: number;
  /** The editor location reached since the last recorded visit (the focused
   *  editor's cursor moves it): the next visit records it first, so Back
   *  returns to where the user left the editor. */
  editorLocation: { current: EditorNavigationLocation | null };
  /** The entry a Back/Forward step is opening, or -1: its activation commits
   *  the step instead of recording a visit. */
  replaying: number;
}

export const NAVIGATION_HISTORY_LIMIT = 50;

/** Whether a session entry can still be opened. A listed session is live
 *  unless archived; a deleted one leaves the catalog and its tabs. Agent
 *  workers are never listed, so an open tab counts; an agent home keeps its
 *  fixed id for good. */
export function sessionStillExists(
  sessionId: string,
  sessions: readonly { id: string; archived?: boolean }[],
  leaves: readonly { tabs: readonly WorkspaceSelection[] }[]
): boolean {
  const listed = sessions.find((session) => session.id === sessionId);
  if (listed) return !listed.archived;
  return (
    isAgentHomeSessionId(sessionId) ||
    leaves.some((leaf) => leaf.tabs.some((tab) => tab.kind === 'session' && tab.id === sessionId))
  );
}

export function createNavigationHistory(): NavigationHistory {
  return { entries: [], index: -1, editorLocation: { current: null }, replaying: -1 };
}

function commitNavigationStep(history: NavigationHistory, index: number): void {
  const entry = history.entries[index];
  history.index = index;
  history.editorLocation.current = entry.kind === 'editor' ? entry.location : null;
}

function sameNavigationEntry(left: NavigationHistoryEntry | undefined, right: NavigationHistoryEntry): boolean {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === 'session') return right.kind === 'session' && left.id === right.id;
  if (right.kind !== 'editor') return false;
  const a = left.location;
  const b = right.location;
  return a.project === b.project && a.rel === b.rel && a.line === b.line && a.accessToken === b.accessToken;
}

export function recordNavigationVisit(history: NavigationHistory, target: NavigationHistoryEntry): void {
  if (history.replaying >= 0 && sameNavigationEntry(history.entries[history.replaying], target)) {
    commitNavigationStep(history, history.replaying);
    return;
  }
  const entries = history.entries.slice(0, history.index + 1);
  const kept = entries.length;
  const append = (entry: NavigationHistoryEntry) => {
    if (!sameNavigationEntry(entries.at(-1), entry)) entries.push(entry);
  };
  const reached = history.editorLocation.current;
  if (reached) append({ kind: 'editor', location: reached });
  append(target);
  history.editorLocation.current = target.kind === 'editor' ? target.location : null;
  // Re-entering the current entry records nothing and keeps forward history;
  // only the current entry dedupes, so A→B→A stays three visits.
  if (entries.length === kept) return;
  history.entries = entries.slice(-NAVIGATION_HISTORY_LIMIT);
  history.index = history.entries.length - 1;
}

interface NavigationStepOpeners {
  /** False for an entry that can no longer be opened (deleted or archived session). */
  available(entry: NavigationHistoryEntry): boolean;
  /** Opens a session through the normal path; its activation commits the step. */
  openSession(sessionId: string): void | Promise<void>;
  openEditor(location: EditorNavigationLocation): void;
}

/** One step back (-1) or forward (1). Dead entries and repeats of the current
 *  entry are skipped; the index moves only once the target activated, and a
 *  session that fails to activate gives way to the next live entry. Resolves
 *  true when a step was taken. */
export async function walkNavigationHistory(
  history: NavigationHistory,
  offset: -1 | 1,
  { available, openSession, openEditor }: NavigationStepOpeners
): Promise<boolean> {
  const current = history.entries[history.index];
  let failure: unknown = null;
  for (let next = history.index + offset; next >= 0 && next < history.entries.length; next += offset) {
    const entry = history.entries[next];
    if (sameNavigationEntry(current, entry) || !available(entry)) continue;
    if (entry.kind === 'editor') {
      try {
        openEditor(entry.location);
      } catch (error) {
        failure = error;
        continue;
      }
      commitNavigationStep(history, next);
      return true;
    }
    history.replaying = next;
    try {
      await openSession(entry.id);
    } catch (error) {
      failure = error;
    } finally {
      history.replaying = -1;
    }
    if (history.index === next) return true;
  }
  if (failure) throw failure;
  return false;
}

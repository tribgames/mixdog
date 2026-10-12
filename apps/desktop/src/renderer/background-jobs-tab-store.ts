import { useSyncExternalStore } from 'react';
import type { JobKind } from './background-jobs-model';

/** Which list (agents or shells) the side dock's background-jobs view shows,
 *  per session: the island segment that opened the dock picks it. */
const requested = new Map<string, JobKind>();
const listeners = new Set<() => void>();

export function requestBackgroundJobsTab(sessionId: string, kind: JobKind): void {
  if (requested.get(sessionId) === kind) return;
  requested.set(sessionId, kind);
  for (const listener of listeners) listener();
}

export function useBackgroundJobsTab(sessionId: string): JobKind {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => requested.get(sessionId) ?? 'agent'
  );
}

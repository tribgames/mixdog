// The getting-started guide's welcome card (and the tour it starts) is a
// modal over the whole window. Anything else that must be seen on top of
// the window — the What's new notice — waits until the guide has released it.
import { useSyncExternalStore } from 'react';

let blocking = false;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Published by StarterGuide: true while its welcome is unanswered or a tour runs. */
export function setStarterGuideBlocking(value: boolean): void {
  if (blocking === value) return;
  blocking = value;
  for (const listener of listeners) listener();
}

export function useStarterGuideBlocking(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => blocking,
    () => false
  );
}

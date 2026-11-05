// The saved SSH servers and the saved remote PCs are this app's own client state (desktop-services.md §15 P11): they
// change when the user saves, renames or forgets one, when a window for one opens or closes, or when the relay
// reports a PC's presence. Whoever changes them says so here; every window re-reads its lists on that event instead
// of on a timer.
const listeners = new Set<() => void>();

export function onHostListsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function notifyHostListsChanged(): void {
  for (const listener of [...listeners]) listener();
}

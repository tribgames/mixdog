const listeners = new Set<() => void>();

export function onHostListsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function notifyHostListsChanged(): void {
  for (const listener of [...listeners]) listener();
}

let ids: ReadonlySet<string> = new Set();
let local: string[] = [];
let host: string[] = [];
const listeners = new Set<() => void>();

export const browserApprovalSessionIds = (): ReadonlySet<string> => ids;

export function subscribeBrowserApprovalSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** This window's own waiting cards. */
export function setBrowserApprovalSessionIds(next: Iterable<string>): void {
  local = [...next];
  publish();
}

/** The PC's waiting cards, as a paired device hears them. */
export function setHostBrowserApprovalSessionIds(next: Iterable<string>): void {
  host = [...next];
  publish();
}

function publish(): void {
  const set = new Set([...local, ...host].filter(Boolean));
  if (set.size === ids.size && [...set].every((id) => ids.has(id))) return;
  ids = set;
  for (const listener of listeners) listener();
}

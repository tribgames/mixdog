// The sessions with a Browser Use approval waiting (the chat it docks in and
// the session that asked), fed to the session attention index so an unopened
// session reads "needs you" in the sidebar and tabs. A new set identity only
// when membership changes.
let ids: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export const browserApprovalSessionIds = (): ReadonlySet<string> => ids;

export function subscribeBrowserApprovalSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setBrowserApprovalSessionIds(next: Iterable<string>): void {
  const set = new Set([...next].filter(Boolean));
  if (set.size === ids.size && [...set].every((id) => ids.has(id))) return;
  ids = set;
  for (const listener of listeners) listener();
}

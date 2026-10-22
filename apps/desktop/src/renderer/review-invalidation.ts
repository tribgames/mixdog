/** A revert (one file, or a whole turn's undo/reapply) changes a session's
 *  review files without a new checkpoint or history epoch. Every successful
 *  revert path publishes it here so any open review surface of that session
 *  re-reads what can still be reverted. */
const listeners = new Map<string, Set<() => void>>();

export function publishReviewInvalidation(sessionId: string): void {
  for (const listener of [...(listeners.get(sessionId) ?? [])]) listener();
}

export function subscribeReviewInvalidation(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size && listeners.get(sessionId) === set) listeners.delete(sessionId);
  };
}

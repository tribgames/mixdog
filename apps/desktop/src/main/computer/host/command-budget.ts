/** Admission happens before enqueuing payloads, not after a worker becomes free. */
export function createComputerCommandBudget(maximum = 32, perSession = 4) {
  const sessions = new Map<string, number>();
  let pending = 0;
  return {
    acquire(sessionId: string): () => void {
      const count = sessions.get(sessionId) || 0;
      if (pending >= maximum || count >= perSession) {
        throw new Error('computer_capacity_exhausted: pending command limit reached; no input was queued');
      }
      pending++;
      sessions.set(sessionId, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending--;
        const remaining = (sessions.get(sessionId) || 1) - 1;
        if (remaining) sessions.set(sessionId, remaining);
        else sessions.delete(sessionId);
      };
    },
  };
}

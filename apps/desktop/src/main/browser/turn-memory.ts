/** What a session remembers per turn (a line already given, a sign-in
 *  already tried). A finished turn never runs commands again (a turn id at or
 *  below a finished one is refused: task-lifecycle.ts `begin`), so its
 *  entries go when it finishes, and a released session's with the session —
 *  there is no count to cap. */
export function createTurnMemory() {
  const bySession = new Map<string, Map<number, Set<string>>>();
  return {
    has(sessionId: string, turnId: number, key: string): boolean {
      return bySession.get(sessionId)?.get(turnId)?.has(key) === true;
    },
    /** Remember `key`; false when it was already remembered. */
    add(sessionId: string, turnId: number, key: string): boolean {
      let turns = bySession.get(sessionId);
      if (!turns) bySession.set(sessionId, (turns = new Map()));
      let keys = turns.get(turnId);
      if (!keys) turns.set(turnId, (keys = new Set()));
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    },
    /** Turn `turnId` and every earlier one of the session finished. */
    finishTurn(sessionId: string, turnId: number): void {
      const turns = bySession.get(sessionId);
      if (!turns) return;
      for (const turn of turns.keys()) if (turn <= turnId) turns.delete(turn);
      if (!turns.size) bySession.delete(sessionId);
    },
    forgetSession(sessionId: string): void {
      bySession.delete(sessionId);
    },
    /** Sessions still holding entries (for tests). */
    sessions(): number {
      return bySession.size;
    },
  };
}

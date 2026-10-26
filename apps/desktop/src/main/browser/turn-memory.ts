/** One turn's memory, as `turn()` took it. */
export interface TurnMemory {
  has(key: string): boolean;
  /** Remember `key`; false when it was already remembered, or when the turn
   *  is no longer live (its session was released, or it finished): a write
   *  after an await never brings back what the teardown dropped. */
  add(key: string): boolean;
}

/** What a session remembers per turn (a line already given, a sign-in
 *  already tried). A finished turn never runs commands again (a turn id at or
 *  below a finished one is refused: task-lifecycle.ts `begin`), so its
 *  entries go when it finishes, and a released session's with the session —
 *  there is no count to cap. A turn's memory is taken once, before the
 *  command's first await; the teardown detaches it, so a command still
 *  running when the session is released or the turn finished cannot write
 *  into the memory afterwards, and a new turn of the same session starts
 *  empty. */
export function createTurnMemory() {
  const bySession = new Map<string, Map<number, Set<string>>>();
  return {
    /** The memory of turn `turnId` of `sessionId`. */
    turn(sessionId: string, turnId: number): TurnMemory {
      let turns = bySession.get(sessionId);
      if (!turns) bySession.set(sessionId, (turns = new Map()));
      const keys = turns.get(turnId) ?? new Set<string>();
      turns.set(turnId, keys);
      const live = () => bySession.get(sessionId)?.get(turnId) === keys;
      return {
        has: (key) => keys.has(key),
        add(key) {
          if (!live() || keys.has(key)) return false;
          keys.add(key);
          return true;
        },
      };
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

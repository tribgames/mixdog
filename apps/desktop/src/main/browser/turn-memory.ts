/** One turn's memory, as `turn()` took it. */
export interface TurnMemory {
  has(key: string): boolean;
  /** Remember `key`; false when it was already remembered, or when the turn
   *  is no longer live (its session was released, or it finished): a write
   *  after an await never brings back what the teardown dropped. */
  add(key: string): boolean;
}

export function createTurnMemory() {
  const bySession = new Map<string, Map<number, Set<string>>>();
  return {
    /** The memory of turn `turnId` of `sessionId`. */
    turn(sessionId: string, turnId: number): TurnMemory {
      let turns = bySession.get(sessionId);
      if (!turns) {
        turns = new Map();
        bySession.set(sessionId, turns);
      }
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

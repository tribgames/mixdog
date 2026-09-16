/** Task-owned pages are disposable; user pages and explicit handoffs are not. */
export function createBrowserTaskLifecycle<Page extends { isDestroyed(): boolean }>(host: {
  current(sessionId: string): Page | null;
  select(sessionId: string, page: Page): void;
  close(page: Page): void;
  canClose(page: Page): boolean;
  preserve?(page: Page): void;
  surface(sessionId: string, request: { temporaryTurnId?: number; restoreTurnId?: number; retainTurnId?: number }): void;
}) {
  type Turn = { previous: Page | null; revealed?: Page; retained?: boolean };
  const turns = new Map<string, Map<number, Turn>>();
  const owned = new Map<Page, { sessionId: string; turnId: number }>();
  const finished = new Map<string, number>();
  function begin(sessionId: string, turnId: number): Turn | undefined {
    if (!Number.isSafeInteger(turnId) || turnId <= 0) return undefined;
    if (turnId <= (finished.get(sessionId) ?? 0)) throw new Error('Browser task has already finished.');
    const group = turns.get(sessionId) ?? new Map<number, Turn>();
    const turn = group.get(turnId) ?? { previous: host.current(sessionId) };
    group.set(turnId, turn);
    turns.set(sessionId, group);
    return turn;
  }
  function use(sessionId: string, turnId: number, page: Page, disposable: boolean): void {
    if (!begin(sessionId, turnId)) return;
    if (disposable || owned.has(page)) owned.set(page, { sessionId, turnId });
  }
  function reveal(sessionId: string, turnId: number, page: Page): boolean {
    const turn = begin(sessionId, turnId);
    if (!turn) return false;
    turn.revealed = page;
    host.surface(sessionId, { temporaryTurnId: turnId });
    return true;
  }
  function retain(page: Page): void {
    owned.delete(page);
    host.preserve?.(page);
    for (const [sessionId, group] of turns) for (const [turnId, turn] of group) {
      if (turn.revealed === page && !turn.retained) {
        turn.retained = true;
        host.surface(sessionId, { retainTurnId: turnId });
      }
    }
  }
  function inherit(opener: Page, popup: Page): void {
    const owner = owned.get(opener);
    if (owner) owned.set(popup, owner);
  }
  function finish(sessionId: string, turnId: number): number {
    if (!Number.isSafeInteger(turnId) || turnId <= 0) throw new Error('Browser cleanup requires a valid turn id.');
    finished.set(sessionId, Math.max(finished.get(sessionId) ?? 0, turnId));
    const group = turns.get(sessionId);
    const turn = group?.get(turnId);
    const pages = [...owned].filter(([, owner]) => owner.sessionId === sessionId && owner.turnId === turnId);
    // Dialogs requiring a human response are a handoff, never disposable.
    for (const [page] of pages) if (!page.isDestroyed() && !host.canClose(page)) retain(page);
    const newerReveal = [...(group?.entries() ?? [])].some(([id, value]) => id > turnId && value.revealed);
    if (turn?.revealed && !turn.retained && !newerReveal) {
      host.surface(sessionId, { restoreTurnId: turnId });
      if (host.current(sessionId) === turn.revealed && turn.previous && !turn.previous.isDestroyed()) {
        host.select(sessionId, turn.previous);
      }
    }
    let closed = 0;
    for (const [page, owner] of pages) {
      if (owned.get(page) !== owner) continue;
      if (!page.isDestroyed()) { host.close(page); closed++; }
      // Keep failed closes owned so a later cleanup can retry. Destruction
      // callbacks may also have retained or reassigned the page meanwhile.
      if (owned.get(page) === owner) owned.delete(page);
    }
    group?.delete(turnId);
    if (!group?.size) turns.delete(sessionId);
    return closed;
  }
  function forget(sessionId: string): void {
    turns.delete(sessionId);
    finished.delete(sessionId);
    for (const [page, owner] of owned) if (owner.sessionId === sessionId) owned.delete(page);
  }
  return { begin, use, reveal, retain, inherit, finish, forget };
}

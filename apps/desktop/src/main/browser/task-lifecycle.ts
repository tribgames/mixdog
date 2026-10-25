/** Task-owned pages are disposable; user pages and explicit handoffs are not.
 *  A turn never opens the panel, so finishing one has no panel to restore. */
export function createBrowserTaskLifecycle<Page extends { isDestroyed(): boolean }>(host: {
  close(page: Page): void;
  canClose(page: Page): boolean;
  preserve?(page: Page): void;
  /** Turn boundaries, for whoever reclaims a finished turn's pages later. */
  turnFinished?(sessionId: string, turnId: number): void;
  turnForgotten?(sessionId: string): void;
}) {
  const owned = new Map<Page, { sessionId: string; turnId: number }>();
  const finished = new Map<string, number>();
  function begin(sessionId: string, turnId: number): boolean {
    if (!Number.isSafeInteger(turnId) || turnId <= 0) return false;
    if (turnId <= (finished.get(sessionId) ?? 0)) throw new Error('Browser task has already finished.');
    return true;
  }
  function use(sessionId: string, turnId: number, page: Page, disposable: boolean): void {
    if (!begin(sessionId, turnId)) return;
    if (disposable || owned.has(page)) owned.set(page, { sessionId, turnId });
  }
  function retain(page: Page): void {
    owned.delete(page);
    host.preserve?.(page);
  }
  function inherit(opener: Page, popup: Page): void {
    const owner = owned.get(opener);
    if (owner) owned.set(popup, owner);
  }
  function finish(sessionId: string, turnId: number, options: { aborted?: boolean } = {}): number {
    if (!Number.isSafeInteger(turnId) || turnId <= 0) throw new Error('Browser cleanup requires a valid turn id.');
    finished.set(sessionId, Math.max(finished.get(sessionId) ?? 0, turnId));
    host.turnFinished?.(sessionId, turnId);
    const pages = [...owned].filter(([, owner]) => owner.sessionId === sessionId && owner.turnId === turnId);
    // Dialogs requiring a human response are a handoff, never disposable.
    for (const [page] of pages) if (!page.isDestroyed() && !host.canClose(page)) retain(page);
    let closed = 0;
    // A finished turn is not a finished conversation. The next message usually
    // continues the same work, and closing its pages would throw away the
    // sign-ins, half-filled forms and tab names already reported. Only a run
    // that ended badly reclaims them here; releasing the session still does.
    if (options.aborted) {
      for (const [page, owner] of pages) {
        if (owned.get(page) !== owner) continue;
        if (!page.isDestroyed()) {
          host.close(page);
          closed++;
        }
        // A close that throws never reaches this release, so the page stays
        // owned and a later cleanup retries it. Destruction callbacks may also
        // have retained or reassigned the page meanwhile.
        if (owned.get(page) === owner) owned.delete(page);
      }
    }
    return closed;
  }
  function forget(sessionId: string): void {
    finished.delete(sessionId);
    host.turnForgotten?.(sessionId);
    for (const [page, owner] of owned) if (owner.sessionId === sessionId) owned.delete(page);
  }
  return { begin, use, retain, inherit, finish, forget };
}

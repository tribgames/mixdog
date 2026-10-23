/**
 * Session ownership for Browser Use resources. Authentication storage remains
 * shared by Electron's persistent partition, while live pages, active targets,
 * attach waiters, and named background tabs are isolated by conversation.
 */
import type { WebContents } from 'electron';

import { selectAndRefreshActiveBrowserGuest } from './tab-policy';
import type { BackgroundPage } from './tabs-contract';

export const DEFAULT_BROWSER_SESSION_ID = 'browser';

export function browserSessionId(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_BROWSER_SESSION_ID;
  }
  if (typeof value !== 'string') {
    throw new TypeError('browser session_id must be a string');
  }
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new TypeError('browser session_id is invalid');
  }
  return sessionId;
}

type GuestWaiter = (guest: WebContents) => void;

export class BrowserSessionRegistry {
  private readonly visibleOrder: WebContents[] = [];
  private readonly sessionByGuest = new Map<WebContents, string>();
  private readonly activeBySession = new Map<string, WebContents>();
  private readonly waitersBySession = new Map<string, Set<GuestWaiter>>();
  private readonly agentPageBySession = new Map<string, { guest: WebContents; turn: number }>();
  /** The turn whose agent page the user stopped the panels from following. */
  private readonly followPausedTurn = new Map<string, number>();
  private readonly backgroundsBySession = new Map<string, Map<string, BackgroundPage>>();

  registerVisibleGuest(guest: WebContents): void {
    if (!this.visibleOrder.includes(guest)) this.visibleOrder.push(guest);
  }

  unregisterVisibleGuest(guest: WebContents): void {
    const index = this.visibleOrder.indexOf(guest);
    if (index >= 0) this.visibleOrder.splice(index, 1);
    const sessionId = this.sessionByGuest.get(guest);
    this.sessionByGuest.delete(guest);
    this.forgetAgentPage(guest);
    if (!sessionId || this.activeBySession.get(sessionId) !== guest) return;
    const fallback =
      this.visibleGuests(sessionId)[0] ??
      [...this.backgroundPages(sessionId).values()].find((page) => !page.guest.isDestroyed())?.guest;
    if (fallback) this.activeBySession.set(sessionId, fallback);
    else this.activeBySession.delete(sessionId);
  }

  bindVisibleGuest(sessionId: string, webContentsId: number, active: boolean): WebContents | null {
    const guest =
      this.visibleOrder.find((candidate) => !candidate.isDestroyed() && candidate.id === webContentsId) ?? null;
    if (!guest) return this.liveGuest(sessionId);

    const previousSessionId = this.sessionByGuest.get(guest);
    if (previousSessionId && previousSessionId !== sessionId) this.forgetAgentPage(guest);
    if (previousSessionId && previousSessionId !== sessionId && this.activeBySession.get(previousSessionId) === guest) {
      const fallback = this.visibleGuests(previousSessionId).find((candidate) => candidate !== guest);
      if (fallback) this.activeBySession.set(previousSessionId, fallback);
      else this.activeBySession.delete(previousSessionId);
    }
    this.sessionByGuest.set(guest, sessionId);

    const selected = selectAndRefreshActiveBrowserGuest(
      this.visibleGuests(sessionId),
      this.activeBySession.get(sessionId) ?? null,
      webContentsId,
      active
    );
    if (selected) this.activeBySession.set(sessionId, selected);
    else this.activeBySession.delete(sessionId);
    this.notifyGuestWaiters(sessionId, guest);
    return selected ?? guest;
  }

  selectGuest(sessionId: string, guest: WebContents): void {
    if (guest.isDestroyed() || this.sessionByGuest.get(guest) !== sessionId) return;
    this.activeBySession.set(sessionId, guest);
  }

  /** The page the agent's latest command drove, with the turn it ran in. It
   *  is independent of the pane's selected tab, which the user may move. */
  setAgentPage(sessionId: string, guest: WebContents, turn: number): void {
    this.agentPageBySession.set(sessionId, { guest, turn });
  }

  /** `paused`: the user picked a tab during this turn, so every window showing
   *  the session stops following until a later turn drives a page or the
   *  user asks to see the agent's page again. */
  agentPage(sessionId: string): { guest: WebContents; turn: number; paused: boolean } | null {
    const page = this.agentPageBySession.get(sessionId);
    if (page && !page.guest.isDestroyed() && this.sessionByGuest.get(page.guest) === sessionId) {
      return { ...page, paused: this.followPausedTurn.get(sessionId) === page.turn };
    }
    this.agentPageBySession.delete(sessionId);
    return null;
  }

  pauseAgentFollow(sessionId: string): void {
    const page = this.agentPage(sessionId);
    if (page) this.followPausedTurn.set(sessionId, page.turn);
  }

  resumeAgentFollow(sessionId: string): void {
    this.followPausedTurn.delete(sessionId);
  }

  /** The session no longer has an agent page (released, or its owner went away). */
  clearAgentPage(sessionId: string): void {
    this.agentPageBySession.delete(sessionId);
    this.followPausedTurn.delete(sessionId);
  }

  private forgetAgentPage(guest: WebContents): void {
    for (const [sessionId, page] of this.agentPageBySession) {
      if (page.guest === guest) this.agentPageBySession.delete(sessionId);
    }
  }

  sessionIdForGuest(guest: WebContents): string | undefined {
    return this.sessionByGuest.get(guest);
  }

  guestForSession(sessionId: string, webContentsId: number): WebContents | null {
    return (
      this.visibleGuests(sessionId).find((guest) => guest.id === webContentsId) ??
      [...this.backgroundPages(sessionId).values()].find(
        (page) => !page.guest.isDestroyed() && page.guest.id === webContentsId
      )?.guest ??
      null
    );
  }

  currentGuest(sessionId: string): WebContents | null {
    const current = this.activeBySession.get(sessionId);
    if (current && !current.isDestroyed() && this.sessionByGuest.get(current) === sessionId) return current;
    // A popup that closed itself is destroyed before its window reports it.
    const opener = current ? this.liveOpener(sessionId, current) : null;
    if (opener) {
      this.activeBySession.set(sessionId, opener);
      return opener;
    }
    this.activeBySession.delete(sessionId);
    return null;
  }

  /** The live page of this session that opened `guest`, a popup, if any:
   *  closing the selected popup returns to it, as Chrome returns to the
   *  tab that opened a closing one. */
  private liveOpener(sessionId: string, guest: WebContents): WebContents | null {
    const opener = this.backgroundPageForGuest(sessionId, guest)?.opener;
    return opener && !opener.isDestroyed() && this.sessionByGuest.get(opener) === sessionId ? opener : null;
  }

  liveGuest(sessionId: string): WebContents | null {
    return this.currentGuest(sessionId) ?? this.visibleGuests(sessionId)[0] ?? null;
  }

  /** The page a pane shows for the session: its live page, else the most
   *  recently used background page (selected, so the pane keeps it) — a pane
   *  opened after the agent made its page shows that page, not a new blank. */
  paneGuest(sessionId: string): WebContents | null {
    const live = this.liveGuest(sessionId);
    if (live) return live;
    let best: BackgroundPage | undefined;
    for (const page of this.backgroundPages(sessionId).values()) {
      if (page.window.isDestroyed() || page.guest.isDestroyed()) continue;
      if (!best || page.lastUsedAt >= best.lastUsedAt) best = page;
    }
    if (!best) return null;
    this.selectGuest(sessionId, best.guest);
    return best.guest;
  }

  visibleGuests(sessionId?: string): WebContents[] {
    return this.visibleOrder.filter(
      (guest) => !guest.isDestroyed() && (sessionId === undefined || this.sessionByGuest.get(guest) === sessionId)
    );
  }

  waitForGuest(sessionId: string, resolve: GuestWaiter): () => void {
    const existing = this.liveGuest(sessionId);
    if (existing) {
      resolve(existing);
      return () => {};
    }
    const waiters = this.waitersBySession.get(sessionId) ?? new Set<GuestWaiter>();
    waiters.add(resolve);
    this.waitersBySession.set(sessionId, waiters);
    return () => {
      waiters.delete(resolve);
      if (!waiters.size && this.waitersBySession.get(sessionId) === waiters) {
        this.waitersBySession.delete(sessionId);
      }
    };
  }

  backgroundPages(sessionId: string): Map<string, BackgroundPage> {
    return this.backgroundsBySession.get(sessionId) ?? new Map();
  }

  /** The named support page a guest belongs to, so callers ask the owner of
   *  the tab graph instead of scanning it themselves. */
  backgroundPageForGuest(sessionId: string, guest: WebContents): BackgroundPage | undefined {
    for (const page of this.backgroundPages(sessionId).values()) {
      if (page.guest === guest) return page;
    }
    return undefined;
  }

  setBackgroundPage(sessionId: string, name: string, page: BackgroundPage): void {
    const pages = this.backgroundsBySession.get(sessionId) ?? new Map<string, BackgroundPage>();
    pages.set(name, page);
    this.backgroundsBySession.set(sessionId, pages);
    this.sessionByGuest.set(page.guest, sessionId);
  }

  deleteBackgroundPage(sessionId: string, name: string, page?: BackgroundPage): void {
    const pages = this.backgroundsBySession.get(sessionId);
    if (!pages) return;
    if (page && pages.get(name) !== page) return;
    const removed = pages.get(name);
    const opener = removed ? this.liveOpener(sessionId, removed.guest) : null;
    pages.delete(name);
    if (removed) this.forgetAgentPage(removed.guest);
    if (removed && this.sessionByGuest.get(removed.guest) === sessionId) {
      this.sessionByGuest.delete(removed.guest);
    }
    if (removed && this.activeBySession.get(sessionId) === removed.guest) {
      const fallback =
        opener ??
        this.visibleGuests(sessionId)[0] ??
        [...pages.values()].find((page) => !page.guest.isDestroyed())?.guest;
      if (fallback) this.activeBySession.set(sessionId, fallback);
      else this.activeBySession.delete(sessionId);
    }
    if (!pages.size) this.backgroundsBySession.delete(sessionId);
  }

  backgroundCount(): number {
    let count = 0;
    for (const pages of this.backgroundsBySession.values()) count += pages.size;
    return count;
  }

  /** Every session that currently owns a page. */
  sessionIds(): string[] {
    return [...new Set(this.sessionByGuest.values())];
  }

  allBackgroundEntries(): Array<[string, string, BackgroundPage]> {
    const entries: Array<[string, string, BackgroundPage]> = [];
    for (const [sessionId, pages] of this.backgroundsBySession) {
      for (const [name, page] of pages) entries.push([sessionId, name, page]);
    }
    return entries;
  }

  clearBackgroundPages(): void {
    for (const [sessionId, , page] of this.allBackgroundEntries()) {
      this.forgetAgentPage(page.guest);
      if (this.sessionByGuest.get(page.guest) === sessionId) {
        this.sessionByGuest.delete(page.guest);
      }
    }
    this.backgroundsBySession.clear();
  }

  private notifyGuestWaiters(sessionId: string, guest: WebContents): void {
    const waiters = this.waitersBySession.get(sessionId);
    if (!waiters) return;
    this.waitersBySession.delete(sessionId);
    for (const resolve of waiters) resolve(guest);
  }
}

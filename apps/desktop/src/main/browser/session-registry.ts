/**
 * Session ownership for Browser Use resources. Authentication storage remains
 * shared by Electron's persistent partition, while live pages, active targets,
 * attach waiters, and named background tabs are isolated by conversation.
 */
import type { WebContents } from 'electron';

import { selectAndRefreshActiveBrowserGuest } from './tab-policy';
import type { BackgroundPage } from './tabs';

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
  private readonly backgroundsBySession = new Map<string, Map<string, BackgroundPage>>();

  registerVisibleGuest(guest: WebContents): void {
    if (!this.visibleOrder.includes(guest)) this.visibleOrder.push(guest);
  }

  unregisterVisibleGuest(guest: WebContents): void {
    const index = this.visibleOrder.indexOf(guest);
    if (index >= 0) this.visibleOrder.splice(index, 1);
    const sessionId = this.sessionByGuest.get(guest);
    this.sessionByGuest.delete(guest);
    if (!sessionId || this.activeBySession.get(sessionId) !== guest) return;
    const fallback = this.visibleGuests(sessionId)[0];
    if (fallback) this.activeBySession.set(sessionId, fallback);
    else this.activeBySession.delete(sessionId);
  }

  bindVisibleGuest(
    sessionId: string,
    webContentsId: number,
    active: boolean,
  ): WebContents | null {
    const guest = this.visibleOrder.find((candidate) =>
      !candidate.isDestroyed() && candidate.id === webContentsId) ?? null;
    if (!guest) return this.liveGuest(sessionId);

    const previousSessionId = this.sessionByGuest.get(guest);
    if (previousSessionId && previousSessionId !== sessionId
      && this.activeBySession.get(previousSessionId) === guest) {
      const fallback = this.visibleGuests(previousSessionId)
        .find((candidate) => candidate !== guest);
      if (fallback) this.activeBySession.set(previousSessionId, fallback);
      else this.activeBySession.delete(previousSessionId);
    }
    this.sessionByGuest.set(guest, sessionId);

    const selected = selectAndRefreshActiveBrowserGuest(
      this.visibleGuests(sessionId),
      this.activeBySession.get(sessionId) ?? null,
      webContentsId,
      active,
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

  sessionIdForGuest(guest: WebContents): string | undefined {
    return this.sessionByGuest.get(guest);
  }

  currentGuest(sessionId: string): WebContents | null {
    const current = this.activeBySession.get(sessionId);
    if (current && !current.isDestroyed()) return current;
    this.activeBySession.delete(sessionId);
    return null;
  }

  liveGuest(sessionId: string): WebContents | null {
    return this.currentGuest(sessionId) ?? this.visibleGuests(sessionId)[0] ?? null;
  }

  visibleGuests(sessionId?: string): WebContents[] {
    return this.visibleOrder.filter((guest) =>
      !guest.isDestroyed()
      && (sessionId === undefined || this.sessionByGuest.get(guest) === sessionId));
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
    pages.delete(name);
    if (removed && this.sessionByGuest.get(removed.guest) === sessionId) {
      this.sessionByGuest.delete(removed.guest);
    }
    if (!pages.size) this.backgroundsBySession.delete(sessionId);
  }

  backgroundCount(): number {
    let count = 0;
    for (const pages of this.backgroundsBySession.values()) count += pages.size;
    return count;
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

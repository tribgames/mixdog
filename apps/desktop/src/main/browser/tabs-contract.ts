/** The pages a session owns and what the tab surface needs from their owner. */
import type { BrowserWindow, WebContents } from 'electron';

/** A never-shown page the agent drives on the shared partition. */
export interface BackgroundPage {
  window: BrowserWindow;
  guest: WebContents;
  lastUsedAt: number;
  kind: 'agent' | 'popup' | 'user';
  keepAlive?: boolean;
  openerPageId?: string;
}

export interface BrowserTabsHost {
  /** Visible pane guests owned by one session, in stable attach order. */
  visibleGuests(sessionId: string): WebContents[];
  backgroundPages(sessionId: string): Map<string, BackgroundPage>;
  backgroundEntryByPageId(sessionId: string, pageId: string): [string, BackgroundPage] | null;
  ensureOffscreen(sessionId: string, rawName?: string): BackgroundPage;
  destroyBackgroundPage(sessionId: string, name: string, entry: BackgroundPage): void;
  pageId(guest: WebContents): string;
  currentGuest(sessionId: string): WebContents | null;
  /** Targeting a visible tab also makes it the default for later commands. */
  selectGuest(sessionId: string, guest: WebContents): void;
  closeGuest(guest: WebContents): void;
}

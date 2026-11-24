import type { WebContents } from 'electron';

import type { BrowserSessionRegistry } from './session-registry';
import {
  BACKGROUND_PAGE_IDLE_MS,
  type BackgroundPageFacts,
  backgroundPageIdle,
  FINISHED_TURN_PAGE_IDLE_MS,
  planBackgroundAdmission,
} from './tab-policy';
import type { BackgroundPage } from './tabs-contract';

export interface BackgroundReclaimHost {
  sessions: Pick<BrowserSessionRegistry, 'allBackgroundEntries' | 'currentGuest' | 'turnFinishedAt'>;
  isBackgroundBusy(sessionId: string, name: string): boolean;
  /** What only the live document has: a person's edits, a pending dialog or
   *  file chooser, a secret typed for a sign-in, the agent's edits while the
   *  session's turn is live (see host-state). */
  holdsUnfinishedWork(sessionId: string, guest: WebContents): boolean;
  close(sessionId: string, name: string, entry: BackgroundPage): void;
  now?: () => number;
}

export function createBackgroundReclaimer(host: BackgroundReclaimHost) {
  const { sessions } = host;
  const clock = host.now ?? Date.now;

  /** Why a page may not be taken for any automatic reclaim; '' when it may. */
  function pinned(sessionId: string, name: string, entry: BackgroundPage): string {
    if (entry.kind !== 'agent') return 'opened by the user';
    if (entry.keepAlive) return 'kept for the user';
    if (sessions.currentGuest(sessionId) === entry.guest) return 'shown to the user';
    if (host.isBackgroundBusy(sessionId, name)) return 'command running';
    if (host.holdsUnfinishedWork(sessionId, entry.guest)) return 'sign-in or input in progress';
    return '';
  }

  function evictionBlocker(sessionId: string, name: string, entry: BackgroundPage): string {
    const pin = pinned(sessionId, name, entry);
    if (pin) return pin;
    return sessions.turnFinishedAt(sessionId) === undefined ? 'turn in progress' : '';
  }

  /** Close every page that is due. */
  function sweep(now = clock()): void {
    for (const [sessionId, name, entry] of sessions.allBackgroundEntries()) {
      if (entry.window.isDestroyed()) {
        host.close(sessionId, name, entry);
        continue;
      }
      if (pinned(sessionId, name, entry)) continue;
      const finishedAt = sessions.turnFinishedAt(sessionId);
      const due =
        (finishedAt !== undefined && backgroundPageIdle(finishedAt, now, FINISHED_TURN_PAGE_IDLE_MS)) ||
        backgroundPageIdle(entry.lastUsedAt, now, BACKGROUND_PAGE_IDLE_MS);
      if (due) host.close(sessionId, name, entry);
    }
  }

  /** Make room for `adding` pages of `sessionId`, or throw why not. */
  function admit(sessionId: string, adding = 1, now = clock()): void {
    sweep(now);
    const pages: BackgroundPageFacts[] = [];
    const entries = new Map<string, [string, string, BackgroundPage]>();
    for (const item of sessions.allBackgroundEntries()) {
      const [owner, name, entry] = item;
      if (entry.window.isDestroyed()) continue;
      pages.push({
        sessionId: owner,
        name,
        lastUsedAt: entry.lastUsedAt,
        blocker: evictionBlocker(owner, name, entry),
      });
      entries.set(`${owner}\0${name}`, item);
    }
    for (const { sessionId: owner, name } of planBackgroundAdmission({ sessionId, adding, pages, now })) {
      const [, , entry] = entries.get(`${owner}\0${name}`)!;
      host.close(owner, name, entry);
    }
  }

  return { sweep, admit };
}

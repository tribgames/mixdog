/**
 * Who may be closed, and when, among the agents' background pages. A session's
 * pages are reclaimed FINISHED_TURN_PAGE_IDLE_MS after its turn ends (the idle
 * fallback covers a live turn), and a full browser evicts another finished
 * session's least-recently-used page. Pages a person opened or kept, the
 * session's shown page, busy pages, and pages holding sign-in or form input
 * are never taken.
 */
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

const UNCHECKED = 'form state not checked yet';

export interface BackgroundReclaimHost {
  sessions: Pick<
    BrowserSessionRegistry,
    | 'allBackgroundEntries'
    | 'backgroundPages'
    | 'currentGuest'
    | 'turnFinishedAt'
    | 'onTurnFinished'
    | 'activityGeneration'
  >;
  /** Changes whenever the page loads a new document. */
  documentGeneration(guest: WebContents): number;
  isBackgroundBusy(sessionId: string, name: string): boolean;
  /** Sign-in or input a person or the agent left in the live document: typed
   *  secrets, user input, a pending dialog or file chooser. */
  holdsUnfinishedWork(guest: WebContents): boolean;
  /** Whether a form field differs from what the document loaded with. */
  hasEditedFields(guest: WebContents): Promise<boolean>;
  close(sessionId: string, name: string, entry: BackgroundPage): void;
  now?: () => number;
}

export function createBackgroundReclaimer(host: BackgroundReclaimHost) {
  const { sessions } = host;
  const clock = host.now ?? Date.now;
  /** The page's last form probe with the state it was taken against. */
  const forms = new WeakMap<WebContents, { state: string; edited: boolean }>();

  /** Everything that can change what a page's forms hold: its own use, its
   *  document, and its session's commands and turn boundaries. */
  function pageState(sessionId: string, entry: BackgroundPage): string {
    return [
      entry.lastUsedAt,
      host.documentGeneration(entry.guest),
      sessions.activityGeneration(sessionId),
      sessions.turnFinishedAt(sessionId) ?? '',
    ].join('|');
  }
  const probing = new WeakSet<WebContents>();

  /** Why a page may not be taken for any automatic reclaim; '' when it may. */
  function pinned(sessionId: string, name: string, entry: BackgroundPage): string {
    if (entry.kind !== 'agent') return 'opened by the user';
    if (entry.keepAlive) return 'kept for the user';
    if (sessions.currentGuest(sessionId) === entry.guest) return 'shown to the user';
    if (host.isBackgroundBusy(sessionId, name)) return 'command running';
    if (host.holdsUnfinishedWork(entry.guest)) return 'sign-in or input in progress';
    return '';
  }

  /** The form check needs a probe taken against the page's current state. */
  function formBlocker(sessionId: string, entry: BackgroundPage): string {
    const probe = forms.get(entry.guest);
    if (!probe || probe.state !== pageState(sessionId, entry)) return UNCHECKED;
    return probe.edited ? 'unsubmitted form input' : '';
  }

  function evictionBlocker(sessionId: string, name: string, entry: BackgroundPage): string {
    const pin = pinned(sessionId, name, entry);
    if (pin) return pin;
    if (sessions.turnFinishedAt(sessionId) === undefined) return 'turn in progress';
    return formBlocker(sessionId, entry);
  }

  async function probe(sessionId: string, name: string, entry: BackgroundPage): Promise<void> {
    if (probing.has(entry.guest) || pinned(sessionId, name, entry)) return;
    probing.add(entry.guest);
    const before = pageState(sessionId, entry);
    try {
      const edited = await host.hasEditedFields(entry.guest);
      // Anything that happened while the probe ran makes its answer history.
      if (pageState(sessionId, entry) === before) forms.set(entry.guest, { state: before, edited });
    } finally {
      probing.delete(entry.guest);
    }
  }

  /** Close what is due; returns the due pages still waiting for a form probe. */
  function reclaim(now = clock()): Array<[string, string, BackgroundPage]> {
    const unchecked: Array<[string, string, BackgroundPage]> = [];
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
      if (!due) continue;
      const blocker = formBlocker(sessionId, entry);
      if (!blocker) host.close(sessionId, name, entry);
      else if (blocker === UNCHECKED) unchecked.push([sessionId, name, entry]);
    }
    return unchecked;
  }

  /** Reclaim now; due pages with no fresh form probe are probed and judged
   *  by the following pass. */
  function sweep(now = clock()): void {
    const unchecked = reclaim(now);
    if (!unchecked.length) return;
    void Promise.allSettled(unchecked.map(([sessionId, name, entry]) => probe(sessionId, name, entry))).then(() =>
      reclaim(clock())
    );
  }

  /** Make room for `adding` pages of `sessionId`, or throw why not. */
  function admit(sessionId: string, adding = 1, now = clock()): void {
    reclaim(now);
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

  /** A finished turn's pages are probed once, so the ceiling can judge them. */
  sessions.onTurnFinished((sessionId) => {
    for (const [name, entry] of sessions.backgroundPages(sessionId)) {
      void probe(sessionId, name, entry).catch(() => {});
    }
  });

  return { sweep, admit };
}

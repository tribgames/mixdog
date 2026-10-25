// A page another session owns, shown in this conversation's browser panel:
// the transcript's "브라우저 · 보기" for a page a task session or sub-agent
// opened (browser-peek-line.tsx). The panel stays in the viewer's
// conversation and shows the owner's tab under its owner's name; it never
// makes a page of the viewer's own for it.
import { useSyncExternalStore } from 'react';
import type { DesktopBrowserTab } from '../shared/contract';

export type BorrowedBrowserTab = { ownerSessionId: string; ownerName: string; tabId: string };
/** A strip tab; `owner` names the session that owns a borrowed page. */
export type BrowserStripTab = DesktopBrowserTab & { owner?: string };

const borrowed = new Map<string, BorrowedBrowserTab>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of [...listeners]) listener();
};

export function showBorrowedBrowserTab(viewerSessionId: string, tab: BorrowedBrowserTab): void {
  if (!viewerSessionId || tab.ownerSessionId === viewerSessionId) return;
  borrowed.set(viewerSessionId, tab);
  notify();
}

export function clearBorrowedBrowserTab(viewerSessionId: string): void {
  if (borrowed.delete(viewerSessionId)) notify();
}

/** `ownerSessionId`'s pages go (its browser hid, or the session was deleted):
 *  every viewer borrowing one forgets it, whatever its dock shows now.
 *  Returns those viewers. */
export function releaseBorrowedBrowserTabsOf(ownerSessionId: string): string[] {
  const viewers = [...borrowed].filter(([, tab]) => tab.ownerSessionId === ownerSessionId).map(([viewer]) => viewer);
  for (const viewer of viewers) borrowed.delete(viewer);
  if (viewers.length) notify();
  return viewers;
}

export function borrowedBrowserTab(viewerSessionId: string): BorrowedBrowserTab | null {
  return borrowed.get(viewerSessionId) ?? null;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useBorrowedBrowserTab(viewerSessionId: string): BorrowedBrowserTab | null {
  return useSyncExternalStore(
    subscribe,
    () => borrowedBrowserTab(viewerSessionId),
    () => null
  );
}

/** The viewer's strip while it shows a borrowed page: that one tab, titled
 *  under its owner; empty once the owner no longer has it. */
export function borrowedStripTabs(
  ownerTabs: readonly DesktopBrowserTab[],
  tab: BorrowedBrowserTab
): BrowserStripTab[] {
  const page = ownerTabs.find((candidate) => candidate.id === tab.tabId);
  return page ? [{ ...page, active: true, owner: tab.ownerName }] : [];
}

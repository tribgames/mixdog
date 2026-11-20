import { t } from './i18n';
import { nextWorkspaceTabAfterClose } from './nav-types';
import type { WorkspaceSelection, WorkspaceTab } from './navigation';
import { paneActiveSelection, type PaneLeaf } from './pane-layout';
import { navigationKey } from './text-format';

/** Drops the sessions' entries from the workspace tab list (the same array
 *  when none was there) and closes their tab in every pane group. */
export function closeSessionTabsEverywhere(
  sessionIds: Iterable<string>,
  setTabs: (update: (current: WorkspaceTab[]) => WorkspaceTab[]) => void,
  closePaneTab: (key: string) => void
): void {
  const gone = new Set(sessionIds);
  if (!gone.size) return;
  setTabs((current) => {
    const next = current.filter((tab) => !(tab.selection.kind === 'session' && gone.has(tab.selection.id)));
    return next.length === current.length ? current : next;
  });
  for (const id of gone) closePaneTab(navigationKey({ kind: 'session', id }));
}

/** What closing a session's tabs means for navigation, read from the panes as
 *  they are when the tabs close: `shown` when the session was the focused
 *  pane's active tab, and then the tab to fall back to (null: a draft). */
export interface SessionTabsClosed {
  shown: boolean;
  fallback: { selection: WorkspaceSelection; title: string } | null;
}

/** Closes the session's tab in every pane group. When it is the focused active
 *  tab, the fallback is the group's neighbour, else another group's active
 *  tab (the same rule as closing the tab by hand). */
export function closeSessionPaneTabs(
  sessionId: string,
  leaves: readonly PaneLeaf[],
  focusedLeafId: string,
  tabs: readonly WorkspaceTab[],
  setTabs: (update: (current: WorkspaceTab[]) => WorkspaceTab[]) => void,
  closePaneTab: (key: string) => void
): SessionTabsClosed {
  const key = navigationKey({ kind: 'session', id: sessionId });
  const focused = leaves.find((leaf) => leaf.id === focusedLeafId);
  const shown = focused?.activeKey === key;
  let fallback: { selection: WorkspaceSelection; title: string } | null = null;
  if (focused && shown) {
    const survivingActive = (leaf: PaneLeaf): WorkspaceSelection | null => {
      const leafTabs = leaf.tabs.map((selection) => ({ key: navigationKey(selection), title: '', selection }));
      return leaf.activeKey === key
        ? (nextWorkspaceTabAfterClose(leafTabs, key)?.selection ?? null)
        : paneActiveSelection(leaf);
    };
    const next =
      survivingActive(focused) ??
      leaves
        .filter((leaf) => leaf.id !== focused.id)
        .map(survivingActive)
        .find(Boolean);
    if (next) {
      fallback = {
        selection: next,
        title: tabs.find((tab) => tab.key === navigationKey(next))?.title || t('New task'),
      };
    }
  }
  closeSessionTabsEverywhere([sessionId], setTabs, closePaneTab);
  return { shown, fallback };
}

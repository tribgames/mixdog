import { t } from './i18n';
import { nextWorkspaceTabAfterClose } from './nav-types';
import type { WorkspaceSelection, WorkspaceTab } from './navigation';
import { paneActiveSelection, type PaneLeaf } from './pane-layout';
import { navigationKey } from './text-format';

/** Closes the session's tab in every pane group. When it is the focused active
 *  tab, returns the tab to fall back to: the group's neighbour, else another
 *  group's active tab (the same rule as closing the tab by hand). */
export function closeSessionPaneTabs(
  sessionId: string,
  leaves: readonly PaneLeaf[],
  focusedLeafId: string,
  tabs: readonly WorkspaceTab[],
  closePaneTab: (key: string) => void
): { selection: WorkspaceSelection; title: string } | null {
  const key = navigationKey({ kind: 'session', id: sessionId });
  const focused = leaves.find((leaf) => leaf.id === focusedLeafId);
  let fallback: { selection: WorkspaceSelection; title: string } | null = null;
  if (focused && focused.activeKey === key) {
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
  closePaneTab(key);
  return fallback;
}

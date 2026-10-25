import type { WorkspaceSelection } from './navigation';
import { paneLeafContainingKey, type PaneNode } from './pane-layout';
import { navigationKey } from './text-format';

/** The main process already foregrounded the app. This reveals the session's
 * existing tab and returns false when none is open, so the caller opens the
 * session instead (use-push-notification-navigation.ts).
 * Revealing it is a tab switch like a strip click: `activateSurface` (the
 * pane chrome's activatePaneSurface) moves the app's selection with it, which
 * the sidebar's session and bot rows highlight. */
export function focusOpenNotificationSession(
  workspace: { layout: PaneNode; activateTab(leafId: string, key: string): void },
  sessionId: string,
  activateSurface: (selection: WorkspaceSelection) => void
): boolean {
  const key = navigationKey({ kind: 'session', id: sessionId });
  const owner = paneLeafContainingKey(workspace.layout, key);
  const tab = owner?.tabs.find((selection) => navigationKey(selection) === key);
  if (!owner || !tab) return false;
  workspace.activateTab(owner.id, key);
  activateSurface(tab);
  return true;
}

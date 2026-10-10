import { paneActiveSelection } from '../pane-layout';
import type { usePaneWorkspace } from '../pane-workspace-state';

/**
 * Persisted panes restore synchronously. The focused pane's selection drives
 * the Files highlight and tab shortcuts; the startup navigation selection is
 * the restored subset that may seed the navigation state.
 */
export function useStartupPaneSelection(paneWorkspace: ReturnType<typeof usePaneWorkspace>) {
  const focusedPaneSelection = paneWorkspace.focusedLeaf ? paneActiveSelection(paneWorkspace.focusedLeaf) : null;
  const startupNavigationSelection =
    paneWorkspace.restoredFromStorage &&
    focusedPaneSelection &&
    focusedPaneSelection.kind !== 'studio' &&
    focusedPaneSelection.kind !== 'terminal' &&
    focusedPaneSelection.kind !== 'browser' &&
    focusedPaneSelection.kind !== 'diff' &&
    focusedPaneSelection.kind !== 'pull-request'
      ? focusedPaneSelection
      : null;
  return { focusedPaneSelection, startupNavigationSelection };
}

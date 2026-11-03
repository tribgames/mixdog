import { useState } from 'react';
import { paneActiveSelection } from '../pane-layout';
import { startsOnProjectlessDraft } from '../startup-view-preference';
import type { usePaneWorkspace } from '../pane-workspace-state';

/**
 * Persisted panes restore synchronously. The focused pane's selection drives
 * the Files highlight and tab shortcuts; the startup navigation selection is
 * the restored subset that may seed the navigation state.
 */
export function useStartupPaneSelection(paneWorkspace: ReturnType<typeof usePaneWorkspace>) {
  // "Start screen: new conversation without a project" opens a fresh draft
  // instead of the restored selection (use-app-startup-restore.ts opens it).
  const [startFresh] = useState(startsOnProjectlessDraft);
  const focusedPaneSelection = paneWorkspace.focusedLeaf ? paneActiveSelection(paneWorkspace.focusedLeaf) : null;
  const startupNavigationSelection =
    !startFresh &&
    paneWorkspace.restoredFromStorage &&
    focusedPaneSelection &&
    focusedPaneSelection.kind !== 'studio' &&
    focusedPaneSelection.kind !== 'terminal' &&
    focusedPaneSelection.kind !== 'browser' &&
    focusedPaneSelection.kind !== 'diff' &&
    focusedPaneSelection.kind !== 'pull-request'
      ? focusedPaneSelection
      : null;
  return { focusedPaneSelection, startupNavigationSelection, startFresh };
}

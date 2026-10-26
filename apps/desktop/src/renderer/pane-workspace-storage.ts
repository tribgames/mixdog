// Persisted pane-layout storage: the stored-tree reader and the initial
// workspace state derived from it. usePaneWorkspace restores through these.
import type { WorkspaceSelection } from './nav-types';
import { createPaneLeaf, normalizePaneLayoutSessions, paneLeaves, type PaneLeaf, type PaneNode } from './pane-layout';
import { parsePaneLayout } from './pane-layout-parse';

export const PANE_LAYOUT_KEY = 'mixdog.desktop.pane-layout.v1';

export interface PaneWorkspaceState {
  layout: PaneNode;
  focusedLeafId: string;
}

type StorageLike = Pick<Storage, 'getItem'>;

export function createNewTaskPaneLeaf(id?: string): PaneLeaf {
  return createPaneLeaf({ kind: 'new' }, id);
}

function fillEmptyPaneLeaves(layout: PaneNode): PaneNode {
  if (layout.type === 'leaf') {
    return layout.tabs.length === 0 ? createNewTaskPaneLeaf(layout.id) : layout;
  }
  const first = fillEmptyPaneLeaves(layout.first);
  const second = fillEmptyPaneLeaves(layout.second);
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The main process's profile-file copy of the layout, read like storage so
 *  `readStoredPaneLayout` validates it the same way. Chromium can lose
 *  localStorage; the file survives. */
export function paneLayoutFileStorage(): StorageLike {
  return { getItem: () => window.mixdogDesktop?.readPaneLayoutFile?.() ?? null };
}

/** Restore a persisted workspace; any malformed layout rejects the whole
 *  stored value so startup always lands on a coherent tree. */
export function readStoredPaneLayout(storage: StorageLike | null): PaneWorkspaceState | null {
  try {
    const raw = storage?.getItem(PANE_LAYOUT_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Record<string, unknown>;
    const parsedLayout = parsePaneLayout(record?.layout);
    if (!parsedLayout) return null;
    const normalizedLayout = normalizePaneLayoutSessions(parsedLayout);
    if (!normalizedLayout) return null;
    const layout = fillEmptyPaneLeaves(normalizedLayout);
    const leaves = paneLeaves(layout);
    const focusedLeafId =
      typeof record.focusedLeafId === 'string' && leaves.some((leaf) => leaf.id === record.focusedLeafId)
        ? record.focusedLeafId
        : leaves[0].id;
    return { layout, focusedLeafId };
  } catch {
    return null;
  }
}

export function initialPaneWorkspaceState(
  stored: PaneWorkspaceState | null,
  initialSelection: WorkspaceSelection | null
): PaneWorkspaceState {
  if (stored) return stored;
  const leaf = initialSelection ? createPaneLeaf(initialSelection) : createNewTaskPaneLeaf();
  return { layout: leaf, focusedLeafId: leaf.id };
}

import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react';

import type { DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { WorkspaceTabStrip, type NavigationSelection, type WorkspaceSelection, type WorkspaceTab } from './navigation';
import type { PaneLeaf } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { t } from './i18n';
import { browserTabTitle, displayProject, navigationKey } from './text-format';

type PaneWorkspace = ReturnType<typeof usePaneWorkspace>;

export function useAppPaneChrome({
  tabs,
  sessions,
  paneWorkspace,
  dirtyFileKeys,
  workingSessionIds,
  unreadSessionIds,
  selectionRef,
  viewedSessionRef,
  unreadViewedSessionRef,
  setSelection,
  startTask,
  activateSelection,
  openFileTab,
  startProject,
  navigateTab,
  closeTab,
  pinPaneTab,
  stripTrailing,
  lastSessionStorageKey,
}: {
  tabs: WorkspaceTab[];
  sessions: DesktopSessionSummary[];
  paneWorkspace: PaneWorkspace;
  dirtyFileKeys: ReadonlySet<string>;
  workingSessionIds: ReadonlySet<string>;
  unreadSessionIds: ReadonlySet<string>;
  selectionRef: MutableRefObject<NavigationSelection>;
  viewedSessionRef: MutableRefObject<string>;
  unreadViewedSessionRef: MutableRefObject<string>;
  setSelection: Dispatch<SetStateAction<NavigationSelection>>;
  startTask(draft?: NavigationSelection, requestComposerFocus?: boolean): void;
  activateSelection(selection: NavigationSelection, title: string): void;
  openFileTab(project: string, rel: string, line?: number, accessToken?: string): void;
  startProject(path: string): void;
  navigateTab(tab: WorkspaceTab): void;
  closeTab(leafId: string, tab: WorkspaceTab): void;
  pinPaneTab(leafId: string, key: string): void;
  /** Right-edge strip controls per leaf (desktop status island). */
  stripTrailing?(leaf: PaneLeaf): ReactNode;
  lastSessionStorageKey: string;
}) {
  const selectionTitle = (selection: WorkspaceSelection): string => {
    switch (selection.kind) {
      case 'session': {
        const row = sessions.find((session) => session.id === selection.id);
        return row ? sessionSummaryTitle(row, t('Untitled session')) : selection.title || t('Session');
      }
      case 'file':
        return selection.rel.split('/').at(-1) || selection.rel;
      case 'diff':
        return t('{{name}} (Diff)', { name: selection.rel.split('/').at(-1) || selection.rel });
      case 'pull-request':
        if (selection.mode === 'changes') return t('Changes in Pull Request #{{number}}', { number: selection.number });
        return selection.title || t('Pull Request #{{number}}', { number: selection.number });
      case 'studio':
        return t('Studio');
      case 'terminal':
        return t('Terminal');
      case 'browser':
        return browserTabTitle(selection);
      case 'project':
        return displayProject(selection.path).name;
      default:
        return t('New task');
    }
  };
  const stripTitleFor = (key: string, selection: WorkspaceSelection): string => {
    const registered = tabs.find((tab) => tab.key === key);
    return registered?.title || selectionTitle(selection);
  };

  const activatePaneSurface = (paneSelection: WorkspaceSelection) => {
    if (
      paneSelection.kind === 'studio' ||
      paneSelection.kind === 'terminal' ||
      paneSelection.kind === 'browser' ||
      paneSelection.kind === 'diff' ||
      paneSelection.kind === 'pull-request'
    )
      return;
    if (paneSelection.kind === 'session') {
      try {
        window.localStorage.setItem(lastSessionStorageKey, paneSelection.id);
      } catch {
        // Remembering the last session is a convenience; storage may be unavailable.
      }
      selectionRef.current = paneSelection;
      viewedSessionRef.current = paneSelection.id;
      unreadViewedSessionRef.current = paneSelection.id;
      setSelection(paneSelection);
    } else if (paneSelection.kind === 'new') {
      if (paneSelection.draftId) startTask(paneSelection, false);
      else activateSelection(paneSelection, t('New task'));
    } else if (paneSelection.kind === 'file') {
      openFileTab(paneSelection.project, paneSelection.rel, undefined, paneSelection.accessToken);
    } else {
      startProject(paneSelection.path);
    }
  };

  const paneStripFor = (leaf: PaneLeaf) => {
    if (leaf.tabs.length === 0) return null;
    const leafTabs = leaf.tabs.map((selection) => {
      const key = navigationKey(selection);
      return {
        key,
        title: stripTitleFor(key, selection),
        selection,
        preview: leaf.previewKey === key,
        pinned: leaf.previewKey !== key,
        dirty: dirtyFileKeys.has(key),
      };
    });
    return (
      <WorkspaceTabStrip
        tabs={leafTabs}
        activeKey={leaf.activeKey}
        sessions={sessions}
        workingSessionIds={workingSessionIds}
        unreadSessionIds={unreadSessionIds}
        focused={leaf.id === paneWorkspace.focusedLeafId}
        paneId={leaf.id}
        trailing={stripTrailing?.(leaf)}
        onSelectTab={(tab) => {
          paneWorkspace.focusLeaf(leaf.id);
          paneWorkspace.activateTab(leaf.id, tab.key);
          navigateTab(tab);
        }}
        onCloseTab={(tab) => closeTab(leaf.id, tab)}
        onReorderTab={(sourceKey, targetKey) => paneWorkspace.reorderTab(leaf.id, sourceKey, targetKey)}
        onPinTab={(tab) => pinPaneTab(leaf.id, tab.key)}
        onNewTask={() => {
          paneWorkspace.focusLeaf(leaf.id);
          startTask();
        }}
      />
    );
  };

  return { activatePaneSurface, paneStripFor, stripTitleFor };
}

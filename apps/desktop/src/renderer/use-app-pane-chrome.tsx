import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react';

import type { DesktopSessionSummary } from '../shared/contract';
import { displaySessionTitle, sessionDisplayTitle } from './session-display-title';
import { WorkspaceTabStrip, type NavigationSelection, type WorkspaceSelection, type WorkspaceTab } from './navigation';
import type { PaneLeaf } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { t } from './i18n';
import { ConversationBell } from './notification-controls';
import { conversationNotificationsAvailable } from './notification-overrides';
import { browserTabTitle, displayProject, navigationKey } from './text-format';
import { isAgentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { agentHomeTitle } from './agent-contacts-model';
import { openAgentProfile } from './agent-panel-tab';
import { isDeletedBotSession } from './agent-chat-mode';
import { useSidebarReferences } from './sidebar-reference-cache';

type PaneWorkspace = ReturnType<typeof usePaneWorkspace>;

/** The notification bell of the pane's active conversation, left of the dock toggles. */
function trailingWithBell(leaf: PaneLeaf, dock: ReactNode): ReactNode {
  const active = leaf.tabs.find((tab) => navigationKey(tab) === leaf.activeKey);
  if (active?.kind !== 'session' || !conversationNotificationsAvailable()) return dock;
  return (
    <>
      <ConversationBell sessionId={active.id} />
      {dock}
    </>
  );
}

const HOME_TITLE_REFERENCE_KEYS = ['agents'] as const;

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
  renameSession,
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
  renameSession(sessionId: string, title: string): Promise<void>;
  /** Right-edge strip controls per leaf (desktop status island). */
  stripTrailing?(leaf: PaneLeaf): ReactNode;
  lastSessionStorageKey: string;
}) {
  // A home thread's tab is its agent's name, also after a reload: the agent
  // catalog is read only while such a tab is open.
  const homeTabOpen = tabs.some((tab) => tab.selection.kind === 'session' && isAgentHomeSessionId(tab.selection.id));
  const { values: homeAgents } = useSidebarReferences(window.mixdogDesktop, HOME_TITLE_REFERENCE_KEYS, homeTabOpen);
  const selectionTitle = (selection: WorkspaceSelection): string => {
    switch (selection.kind) {
      case 'session': {
        const row = sessions.find((session) => session.id === selection.id);
        return row
          ? sessionDisplayTitle(row, t('Untitled session'))
          : displaySessionTitle(selection.title || '') || t('Session');
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
    // A deleted bot's chat carries the bot's name as its own title (host).
    const deletedBot = selection.kind === 'session' && isDeletedBotSession(selection.id);
    const home = selection.kind === 'session' && !deletedBot ? agentHomeTitle(selection.id, homeAgents.agents) : null;
    if (home) return home;
    const registered = tabs.find((tab) => tab.key === key);
    // A registered session title may be a stored one (startup restore, a
    // persisted tab): an attachment placeholder reads as its kind.
    const title = registered?.title && selection.kind === 'session' ? displaySessionTitle(registered.title) : '';
    return title || registered?.title || selectionTitle(selection);
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
    // An open announced in this commit shows its tab before the pane renders.
    const shown = paneWorkspace.stripLeaf(leaf);
    // A bot chat is a tab of the shared strip like any session, on the phone too.
    const stripTabs = shown.tabs;
    if (stripTabs.length === 0) return null;
    const leafTabs = stripTabs.map((selection) => {
      const key = navigationKey(selection);
      return {
        key,
        title: stripTitleFor(key, selection),
        selection,
        preview: shown.previewKey === key,
        pinned: shown.previewKey !== key,
        dirty: dirtyFileKeys.has(key),
      };
    });
    return (
      <WorkspaceTabStrip
        tabs={leafTabs}
        activeKey={shown.activeKey}
        sessions={sessions}
        workingSessionIds={workingSessionIds}
        unreadSessionIds={unreadSessionIds}
        focused={leaf.id === paneWorkspace.focusedLeafId}
        paneId={leaf.id}
        trailing={trailingWithBell(leaf, stripTrailing?.(leaf))}
        onSelectTab={(tab) => {
          // The agent's name on its open home tab (the phone's thread header
          // too) opens its profile.
          if (
            tab.key === shown.activeKey &&
            tab.selection.kind === 'session' &&
            isAgentHomeSessionId(tab.selection.id)
          ) {
            paneWorkspace.focusLeaf(leaf.id);
            openAgentProfile(tab.selection.id);
            return;
          }
          paneWorkspace.focusLeaf(leaf.id);
          paneWorkspace.activateTab(leaf.id, tab.key);
          navigateTab(tab);
        }}
        onCloseTab={(tab) => closeTab(leaf.id, tab)}
        onReorderTab={(sourceKey, targetKey) => paneWorkspace.reorderTab(leaf.id, sourceKey, targetKey)}
        onPinTab={(tab) => pinPaneTab(leaf.id, tab.key)}
        onRenameSession={renameSession}
        onNewTask={() => {
          paneWorkspace.focusLeaf(leaf.id);
          startTask();
        }}
      />
    );
  };

  return { activatePaneSurface, paneStripFor, stripTitleFor };
}

import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { t } from './i18n';
import { disposeTerminalPane } from './lazy-widgets';
import { nextWorkspaceTabAfterClose } from './nav-types';
import type { NavigationSelection, WorkspaceTab } from './navigation';
import { paneActiveSelection } from './pane-layout';
import { dirtySideFilesClosedWith, paneDockOwnerOf, type PaneSideDockEntry } from './pane-side-dock-model';
import type { usePaneWorkspace } from './pane-workspace-state';
import { sideFileDirtyKey, sideFileTabDirtyKey, type PaneSideDockFile } from './side-file-tabs';
import { navigationKey } from './text-format';

type PaneWorkspace = ReturnType<typeof usePaneWorkspace>;

export type ConversationHandoff = {
  kind: 'close';
  leafId: string;
  selection: Extract<NavigationSelection, { kind: 'session' | 'new' }>;
};

export interface EditorSaveHandle {
  save(): Promise<boolean>;
  discard(): Promise<void>;
}

interface PendingUnsavedClose {
  leafId: string;
  tab: WorkspaceTab;
  /** A side-dock file leaves through this instead of closing a tab. */
  proceed?: () => void;
}

/** A tab that shows a conversation (a draft, a session or a project's). */
function isConversationKind(kind: string): boolean {
  return kind === 'new' || kind === 'session' || kind === 'project';
}

function tabOpenInOtherLeaf(leaves: PaneWorkspace['leaves'], leafId: string, tabKey: string): boolean {
  return leaves.some(
    (entry) => entry.id !== leafId && entry.tabs.some((selection) => navigationKey(selection) === tabKey)
  );
}

function fallbackTabAfterClose(
  leaves: PaneWorkspace['leaves'],
  leaf: PaneWorkspace['leaves'][number],
  tab: WorkspaceTab
): WorkspaceTab | undefined {
  const leafTabs: WorkspaceTab[] = leaf.tabs.map((selection) => ({
    key: navigationKey(selection),
    title: '',
    selection,
  }));
  const groupFallback = nextWorkspaceTabAfterClose(leafTabs, tab.key);
  if (groupFallback) return groupFallback;
  const neighbor = leaves.find((entry) => entry.id !== leaf.id);
  if (!neighbor) return undefined;
  const selection = paneActiveSelection(neighbor);
  return selection ? { key: navigationKey(selection), title: '', selection } : undefined;
}

export function usePaneTabClose({
  paneWorkspace,
  paneSideDocks,
  dirtyFileKeys,
  editorSaveHandles,
  handleFileDirty,
  setTabs,
  pendingConversationHandoff,
  setConversationHandoff,
  openSession,
  navigateTab,
  selectionRef,
  viewedSessionRef,
  unreadViewedSessionRef,
  setSelection,
  setRequestedSessionId,
  setComposerFocusRequest,
  lastSessionStorageKey,
}: {
  paneWorkspace: PaneWorkspace;
  /** The pane docks: a tab's dirty side files are confirmed before it closes. */
  paneSideDocks: { docks: Readonly<Record<string, PaneSideDockEntry>> };
  dirtyFileKeys: ReadonlySet<string>;
  editorSaveHandles: MutableRefObject<Map<string, EditorSaveHandle>>;
  handleFileDirty(key: string, dirty: boolean): void;
  setTabs: Dispatch<SetStateAction<WorkspaceTab[]>>;
  pendingConversationHandoff: MutableRefObject<ConversationHandoff | null>;
  setConversationHandoff: Dispatch<SetStateAction<ConversationHandoff | null>>;
  openSession(sessionId: string): Promise<void>;
  navigateTab(tab: WorkspaceTab): void;
  selectionRef: MutableRefObject<NavigationSelection>;
  viewedSessionRef: MutableRefObject<string>;
  unreadViewedSessionRef: MutableRefObject<string>;
  setSelection: Dispatch<SetStateAction<NavigationSelection>>;
  setRequestedSessionId: Dispatch<SetStateAction<string>>;
  setComposerFocusRequest: Dispatch<SetStateAction<number>>;
  lastSessionStorageKey: string;
}) {
  const [pendingUnsavedCloses, setPendingUnsavedCloses] = useState<PendingUnsavedClose[]>([]);
  const pendingUnsavedClose = pendingUnsavedCloses[0] ?? null;
  const [unsavedCloseBusy, setUnsavedCloseBusy] = useState(false);
  const [unsavedCloseError, setUnsavedCloseError] = useState('');

  // Every close reads the panes as the close before it left them: a menu's
  // "Close Others" closes several tabs before the next render.
  const releaseClosedTab = (leafId: string, tab: WorkspaceTab) => {
    if (!tabOpenInOtherLeaf(paneWorkspace.now().leaves, leafId, tab.key)) {
      if (tab.selection.kind === 'file') {
        handleFileDirty(tab.key, false);
        editorSaveHandles.current.delete(tab.key);
      }
      if (tab.selection.kind === 'terminal') void disposeTerminalPane(tab.selection.id);
      if (tab.selection.kind === 'browser') void window.mixdogDesktop?.browserReleasePage?.(tab.selection.id);
      setTabs((current) => current.filter((item) => item.key !== tab.key));
    }
    paneWorkspace.closeTab(leafId, tab.key);
  };

  const resetToNewTask = () => {
    selectionRef.current = { kind: 'new' };
    viewedSessionRef.current = '';
    unreadViewedSessionRef.current = '';
    setSelection({ kind: 'new' });
    setRequestedSessionId('');
    try {
      window.localStorage.removeItem(lastSessionStorageKey);
    } catch {
      /* best-effort */
    }
  };

  const closeTabNow = (leafId: string, tab: WorkspaceTab) => {
    const { leaves, focusedLeafId } = paneWorkspace.now();
    const leaf = leaves.find((entry) => entry.id === leafId);
    if (!leaf) return;
    const wasActive = leafId === focusedLeafId && tab.key === leaf.activeKey;
    if (!wasActive) {
      releaseClosedTab(leafId, tab);
      return;
    }
    const fallback = fallbackTabAfterClose(leaves, leaf, tab);
    const closingSession = isConversationKind(tab.selection.kind);
    if (closingSession && fallback?.selection.kind === 'session') {
      if (tab.selection.kind === 'session' || tab.selection.kind === 'new') {
        const handoff: ConversationHandoff = {
          kind: 'close',
          leafId,
          selection: tab.selection,
        };
        pendingConversationHandoff.current = handoff;
        setConversationHandoff(handoff);
      }
      releaseClosedTab(leafId, tab);
      void openSession(fallback.selection.id);
      return;
    }
    releaseClosedTab(leafId, tab);
    if (fallback) navigateTab(fallback);
    else resetToNewTask();
    if (!closingSession && fallback && isConversationKind(fallback.selection.kind)) {
      setComposerFocusRequest((value) => value + 1);
    }
  };

  /** The dirty side-dock files closing the tab would drop: its pane's whole
   *  dock when the pane closes with it, else what the tab's session owns there. */
  const dirtySideFilesOf = (leafId: string, tab: WorkspaceTab): PaneSideDockFile[] => {
    const { leaves } = paneWorkspace.now();
    const leaf = leaves.find((entry) => entry.id === leafId);
    if (!leaf) return [];
    const tabbedElsewhere = (owner: string) =>
      leaves.some(
        (entry) => entry.id !== leafId && entry.tabs.some((selection) => paneDockOwnerOf(selection) === owner)
      );
    return dirtySideFilesClosedWith(
      paneSideDocks.docks[leafId],
      paneDockOwnerOf(tab.selection),
      leaves.length > 1 && leaf.tabs.length === 1,
      tabbedElsewhere,
      (fileKey) => dirtyFileKeys.has(sideFileTabDirtyKey(fileKey))
    );
  };

  /** Confirms each dirty side file in turn, then closes the tab. */
  const closeTabAfterSideFiles = (leafId: string, tab: WorkspaceTab, files: readonly PaneSideDockFile[]) => {
    const [file, ...rest] = files;
    if (!file) {
      closeTabNow(leafId, tab);
      return;
    }
    const key = sideFileDirtyKey(file);
    confirmSideFileExit(key, file, () => {
      handleFileDirty(key, false);
      closeTabAfterSideFiles(leafId, tab, rest);
    });
  };

  const closeTab = (leafId: string, tab: WorkspaceTab) => {
    if (tabOpenInOtherLeaf(paneWorkspace.now().leaves, leafId, tab.key)) {
      closeTabNow(leafId, tab);
      return;
    }
    if (tab.selection.kind === 'file' && dirtyFileKeys.has(tab.key)) {
      setUnsavedCloseError('');
      setPendingUnsavedCloses((queue) =>
        queue.some((entry) => entry.tab.key === tab.key) ? queue : [...queue, { leafId, tab }]
      );
      return;
    }
    closeTabAfterSideFiles(leafId, tab, dirtySideFilesOf(leafId, tab));
  };

  const saveAndClosePendingTab = async () => {
    const pending = pendingUnsavedClose;
    if (!pending || unsavedCloseBusy) return;
    const handle = editorSaveHandles.current.get(pending.tab.key);
    if (!handle) {
      setUnsavedCloseError(t('The editor is unavailable. Return to the file and try again.'));
      return;
    }
    setUnsavedCloseBusy(true);
    setUnsavedCloseError('');
    const saved = await handle.save();
    setUnsavedCloseBusy(false);
    if (!saved) {
      setUnsavedCloseError(t('The file could not be saved. Resolve the editor error and try again.'));
      return;
    }
    setPendingUnsavedCloses((queue) => queue.slice(1));
    if (pending.proceed) pending.proceed();
    else closeTabNow(pending.leafId, pending.tab);
  };

  /** The same Save / Discard / Cancel dialog for a side-dock file; `proceed`
   *  runs once its edits are saved or discarded. */
  const confirmSideFileExit = (key: string, target: { project: string; rel: string }, proceed: () => void) => {
    const tab: WorkspaceTab = {
      key,
      title: target.rel.split('/').at(-1) || target.rel,
      selection: { kind: 'file', project: target.project, rel: target.rel },
    };
    setUnsavedCloseError('');
    setPendingUnsavedCloses((queue) =>
      queue.some((entry) => entry.tab.key === key) ? queue : [...queue, { leafId: '', tab, proceed }]
    );
  };

  const discardAndClosePendingTab = async () => {
    const pending = pendingUnsavedClose;
    if (!pending || unsavedCloseBusy) return;
    await editorSaveHandles.current.get(pending.tab.key)?.discard();
    setPendingUnsavedCloses((queue) => queue.slice(1));
    setUnsavedCloseError('');
    if (pending.proceed) pending.proceed();
    else closeTabNow(pending.leafId, pending.tab);
  };

  const cancelPendingTabClose = () => {
    if (unsavedCloseBusy) return;
    setPendingUnsavedCloses([]);
    setUnsavedCloseError('');
  };

  return {
    cancelPendingTabClose,
    closeTab,
    confirmSideFileExit,
    discardAndClosePendingTab,
    pendingUnsavedClose,
    saveAndClosePendingTab,
    unsavedCloseBusy,
    unsavedCloseError,
  };
}

import {
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import { disposeTerminalPane } from "./lazy-widgets";
import { nextWorkspaceTabAfterClose } from "./nav-types";
import {
  type NavigationSelection,
  type WorkspaceTab,
} from "./navigation";
import { paneActiveSelection } from "./pane-layout";
import { usePaneWorkspace } from "./pane-workspace-state";
import { navigationKey } from "./text-format";

type PaneWorkspace = ReturnType<typeof usePaneWorkspace>;

export type ConversationHandoff = {
  kind: "close";
  leafId: string;
  selection: Extract<NavigationSelection, { kind: "session" | "new" }>;
};

interface EditorSaveHandle {
  save(): Promise<boolean>;
  discard(): Promise<void>;
}

interface PendingUnsavedClose {
  leafId: string;
  tab: WorkspaceTab;
}

export function usePaneTabClose({
  paneWorkspace,
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
  const [pendingUnsavedCloses, setPendingUnsavedCloses] =
    useState<PendingUnsavedClose[]>([]);
  const pendingUnsavedClose = pendingUnsavedCloses[0] ?? null;
  const [unsavedCloseBusy, setUnsavedCloseBusy] = useState(false);
  const [unsavedCloseError, setUnsavedCloseError] = useState("");

  const closeTabNow = (leafId: string, tab: WorkspaceTab) => {
    const leaf = paneWorkspace.leaves.find((entry) => entry.id === leafId);
    if (!leaf) return;
    const openElsewhere = paneWorkspace.leaves.some((entry) => entry.id !== leafId
      && entry.tabs.some((selection) => navigationKey(selection) === tab.key));
    const leafTabs: WorkspaceTab[] = leaf.tabs.map((selection) => ({
      key: navigationKey(selection), title: "", selection,
    }));
    const groupFallback = nextWorkspaceTabAfterClose(leafTabs, tab.key);
    const wasFocused = leafId === paneWorkspace.focusedLeafId;
    const wasActive = wasFocused && tab.key === leaf.activeKey;
    const closingSession = tab.selection.kind === "new"
      || tab.selection.kind === "session"
      || tab.selection.kind === "project";
    const fallback = groupFallback ?? (() => {
      const neighbor = paneWorkspace.leaves.find((entry) => entry.id !== leafId);
      if (!neighbor) return undefined;
      const selection = paneActiveSelection(neighbor);
      return selection ? { key: navigationKey(selection), title: "", selection } : undefined;
    })();
    const commitClose = () => {
      if (!openElsewhere) {
        if (tab.selection.kind === "file") {
          handleFileDirty(tab.key, false);
          editorSaveHandles.current.delete(tab.key);
        }
        if (tab.selection.kind === "terminal") void disposeTerminalPane(tab.selection.id);
        setTabs((current) => current.filter((item) => item.key !== tab.key));
      }
      paneWorkspace.closeTab(leafId, tab.key);
    };
    if (!wasActive) {
      commitClose();
      return;
    }
    if (closingSession && fallback?.selection.kind === "session") {
      if (tab.selection.kind === "session" || tab.selection.kind === "new") {
        const handoff: ConversationHandoff = {
          kind: "close",
          leafId,
          selection: tab.selection,
        };
        pendingConversationHandoff.current = handoff;
        setConversationHandoff(handoff);
      }
      commitClose();
      void openSession(fallback.selection.id);
      return;
    }
    commitClose();
    if (fallback) navigateTab(fallback);
    else {
      selectionRef.current = { kind: "new" };
      viewedSessionRef.current = "";
      unreadViewedSessionRef.current = "";
      setSelection({ kind: "new" });
      setRequestedSessionId("");
      try { window.localStorage.removeItem(lastSessionStorageKey); } catch { /* best-effort */ }
    }
    if (!closingSession && fallback
      && (fallback.selection.kind === "new" || fallback.selection.kind === "session"
        || fallback.selection.kind === "project")) {
      setComposerFocusRequest((value) => value + 1);
    }
  };

  const closeTab = (leafId: string, tab: WorkspaceTab) => {
    const openElsewhere = paneWorkspace.leaves.some((entry) => entry.id !== leafId
      && entry.tabs.some((selection) => navigationKey(selection) === tab.key));
    if (!openElsewhere && tab.selection.kind === "file" && dirtyFileKeys.has(tab.key)) {
      setUnsavedCloseError("");
      setPendingUnsavedCloses((queue) =>
        queue.some((entry) => entry.tab.key === tab.key) ? queue : [...queue, { leafId, tab }]);
      return;
    }
    closeTabNow(leafId, tab);
  };

  const saveAndClosePendingTab = async () => {
    const pending = pendingUnsavedClose;
    if (!pending || unsavedCloseBusy) return;
    const handle = editorSaveHandles.current.get(pending.tab.key);
    if (!handle) {
      setUnsavedCloseError("The editor is unavailable. Return to the file and try again.");
      return;
    }
    setUnsavedCloseBusy(true);
    setUnsavedCloseError("");
    const saved = await handle.save();
    setUnsavedCloseBusy(false);
    if (!saved) {
      setUnsavedCloseError("The file could not be saved. Resolve the editor error and try again.");
      return;
    }
    setPendingUnsavedCloses((queue) => queue.slice(1));
    closeTabNow(pending.leafId, pending.tab);
  };

  const discardAndClosePendingTab = async () => {
    const pending = pendingUnsavedClose;
    if (!pending || unsavedCloseBusy) return;
    await editorSaveHandles.current.get(pending.tab.key)?.discard();
    setPendingUnsavedCloses((queue) => queue.slice(1));
    setUnsavedCloseError("");
    closeTabNow(pending.leafId, pending.tab);
  };

  const cancelPendingTabClose = () => {
    if (unsavedCloseBusy) return;
    setPendingUnsavedCloses([]);
    setUnsavedCloseError("");
  };

  return {
    cancelPendingTabClose,
    closeTab,
    discardAndClosePendingTab,
    pendingUnsavedClose,
    saveAndClosePendingTab,
    unsavedCloseBusy,
    unsavedCloseError,
  };
}

import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { WorkspaceSelection, WorkspaceTab } from "./navigation";
import type { usePaneWorkspace } from "./pane-workspace-state";
import { navigationKey } from "./text-format";
import { useWorkspaceShortcuts } from "./app-workspace-shortcuts";

type PaneWorkspace = ReturnType<typeof usePaneWorkspace>;

export function useAppWorkspaceNavigation({
  paneWorkspace,
  requestedSessionId,
  focusedPaneSelection,
  activeTabKey,
  navigateTab,
  focusSiblingPane,
  focusVerticalPane,
  startTask,
  openSettings,
  toggleSidebar,
  toggleDock,
  toggleBottomPanel,
  setQuickAccessMode,
  openDockTab,
  navigateEditorHistory,
}: {
  paneWorkspace: PaneWorkspace;
  requestedSessionId: string;
  focusedPaneSelection: WorkspaceSelection | null | undefined;
  activeTabKey: string;
  navigateTab(tab: WorkspaceTab): void;
  focusPaneTypingSurface(leafId: string, selection: WorkspaceSelection | null | undefined): void;
  focusSiblingPane(offset: number): void;
  focusVerticalPane(direction: "up" | "down"): void;
  startTask(): void;
  openSettings(): void;
  toggleSidebar(): void;
  toggleDock(): void;
  toggleBottomPanel(): void;
  setQuickAccessMode: Dispatch<SetStateAction<"files" | "commands" | null>>;
  openDockTab(tab: "search"): void;
  navigateEditorHistory(offset: -1 | 1): void;
}) {
  const tabMruRef = useRef<string[]>([]);
  const [tabSwitcher, setTabSwitcher] = useState<{ keys: string[]; index: number } | null>(null);
  const focusedLeafForShortcuts = paneWorkspace.focusedLeaf;
  const focusedLeafTabs = useMemo<WorkspaceTab[]>(
    () => (focusedLeafForShortcuts?.tabs ?? []).map((selection) => ({
      key: navigationKey(selection),
      title: "",
      selection,
    })),
    [focusedLeafForShortcuts],
  );
  // The visible pane model is authoritative for shortcuts. An in-flight
  // session request may belong to the pane we just left and must not pull
  // traversal back toward that pane's last selected tab.
  const focusedActiveTabKey = focusedPaneSelection
    ? navigationKey(focusedPaneSelection)
    : requestedSessionId
      ? navigationKey({ kind: "session", id: requestedSessionId })
      : activeTabKey;

  useEffect(() => {
    if (!focusedActiveTabKey) return;
    tabMruRef.current = [
      focusedActiveTabKey,
      ...tabMruRef.current.filter((key) => key !== focusedActiveTabKey),
    ].slice(0, 100);
  }, [focusedActiveTabKey]);

  const openTabSwitcher = (offset: number) => {
    if (focusedLeafTabs.length < 2) return;
    setTabSwitcher((current) => {
      if (current) {
        return {
          ...current,
          index: (current.index + offset + current.keys.length) % current.keys.length,
        };
      }
      const mru = tabMruRef.current;
      const keys = [
        ...mru.filter((key) => focusedLeafTabs.some((tab) => tab.key === key)),
        ...focusedLeafTabs.map((tab) => tab.key).filter((key) => !mru.includes(key)),
      ];
      if (keys.length < 2) return current;
      return { keys, index: offset > 0 ? 1 : keys.length - 1 };
    });
  };

  const navigateFocusedPaneTab = (tab: WorkspaceTab) => {
    paneWorkspace.activateTab(paneWorkspace.focusedLeafId, tab.key);
    navigateTab(tab);
  };

  useEffect(() => {
    if (!tabSwitcher) return undefined;
    const commit = () => {
      setTabSwitcher(null);
      const key = tabSwitcher.keys[tabSwitcher.index];
      const tab = focusedLeafTabs.find((entry) => entry.key === key);
      if (tab && key !== focusedActiveTabKey) navigateFocusedPaneTab(tab);
    };
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTabSwitcher(null);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") commit();
    };
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("blur", commit);
    return () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("blur", commit);
    };
  }, [tabSwitcher, focusedLeafTabs, focusedActiveTabKey, navigateFocusedPaneTab]);

  useWorkspaceShortcuts({
    tabs: focusedLeafTabs,
    activeTabKey: focusedActiveTabKey,
    navigateTab: navigateFocusedPaneTab,
    focusSiblingPane,
    focusVerticalPane,
    startTask,
    openSettings,
    toggleSidebar,
    toggleDock,
    togglePanel: toggleBottomPanel,
    openQuickAccess: () => setQuickAccessMode("files"),
    openCommandPalette: () => setQuickAccessMode("commands"),
    openFindInFiles: () => {
      openDockTab("search");
      window.dispatchEvent(new CustomEvent("mixdog:focus-dock-search"));
    },
    openTabSwitcher,
    navigateBack: () => navigateEditorHistory(-1),
    navigateForward: () => navigateEditorHistory(1),
  });

  return {
    focusedLeafForShortcuts,
    focusedLeafTabs,
    tabSwitcher,
  };
}

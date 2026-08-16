// THE workbench keymap. One table, resolved in the CAPTURE phase, so every
// surface (xterm, Monaco, composer, Studio prompt) obeys the same bindings
// instead of swallowing them;
// user: 단축키는 우리 걸로 다 인터셉트해서 먼저 처리). Only an open modal
// outranks the table. User-tuned bindings:
// mod+N new task · ctrl+Tab MRU switcher · ctrl+PageUp/PageDown cycle ·
// mod+Left/Right tab traversal, crossing pane boundaries in visual order ·
// mod+P Quick Open · shift+mod+P Command Palette ·
// mod+, settings · mod+B left sidebar · alt+mod+B right utility dock ·
// mod+J panel · ctrl+` and mod+T toggle the terminal panel ·
// shift+mod+F find in files · mod+W and ctrl+Q close.
import { useEffect, useRef } from "react";

import type { WorkspaceTab } from "./navigation";

export interface WorkspaceShortcutActions {
  tabs: WorkspaceTab[];
  activeTabKey: string;
  navigateTab: (tab: WorkspaceTab) => void;
  startTask: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
  toggleDock: () => void;
  togglePanel: () => void;
  openTerminalPanel: () => void;
  openQuickAccess: () => void;
  openCommandPalette: () => void;
  openFindInFiles: () => void;
  /** Ctrl+Tab: open or advance the MRU tab switcher. */
  openTabSwitcher: (offset: number) => void;
  /** Move focus to the previous/next pane in visual row-major order. */
  focusSiblingPane: (offset: number) => void;
  navigateBack: () => void;
  navigateForward: () => void;
}

export function useWorkspaceShortcuts(actions: WorkspaceShortcutActions) {
  // The listener binds once; every render refreshes the callbacks it reads so
  // a shortcut always acts on the current tab set.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const cycleTab = (offset: number, crossPaneBoundary = false) => {
      const { tabs, activeTabKey, navigateTab } = actionsRef.current;
      const index = tabs.findIndex((tab) => tab.key === activeTabKey);
      if (index < 0) return;
      const nextIndex = index + offset;
      const next = crossPaneBoundary
        ? tabs[nextIndex]
        : tabs[(nextIndex + tabs.length) % tabs.length];
      if (next) navigateTab(next);
      else if (crossPaneBoundary) actionsRef.current.focusSiblingPane(offset);
    };
    const closeActiveTab = () => {
      // The workspace handles keyboard and pointer close through one path.
      window.dispatchEvent(new window.CustomEvent("mixdog:close-active-tab"));
    };
    /** The keymap itself: returns the command for an event, or null. */
    const resolve = (event: globalThis.KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return null;
      const key = event.key.toLowerCase();
      const plain = !event.shiftKey && !event.altKey;
      if (plain && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        return () => cycleTab(offset, true);
      }
      if (plain && (event.key === "PageUp" || event.key === "PageDown")) {
        const offset = event.key === "PageDown" ? 1 : -1;
        return () => cycleTab(offset);
      }
      if (event.key === "Tab" && !event.altKey) {
        const offset = event.shiftKey ? -1 : 1;
        return () => actionsRef.current.openTabSwitcher(offset);
      }
      if (key === "p" && !event.altKey) {
        return event.shiftKey
          ? () => actionsRef.current.openCommandPalette()
          : () => actionsRef.current.openQuickAccess();
      }
      if (key === "f" && event.shiftKey && !event.altKey) {
        return () => actionsRef.current.openFindInFiles();
      }
      // Ctrl+B = left side bar, Ctrl+Alt+B = right utility dock (user).
      if (key === "b" && plain) return () => actionsRef.current.toggleSidebar();
      if (key === "b" && event.altKey && !event.shiftKey) {
        return () => actionsRef.current.toggleDock();
      }
      if (!plain) return null;
      if (key === "n") return () => actionsRef.current.startTask();
      if (key === ",") return () => actionsRef.current.openSettings();
      if (key === "j") return () => actionsRef.current.togglePanel();
      // Ctrl+T and Ctrl+` TOGGLE the bottom terminal panel (user: 다시 눌러
      // 닫혀야 함); the tab strip no longer steals Ctrl+T for a new task.
      if (key === "t" || event.key === "`") {
        return () => actionsRef.current.openTerminalPanel();
      }
      if (key === "w" || key === "q") return closeActiveTab;
      return null;
    };
    const onShortcutCapture = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // An IME composition owns its own keystrokes until it commits.
      if (event.isComposing || event.keyCode === 229) return;
      // Save/discard and other modal confirmations own every key until they
      // settle, even if focus momentarily remains in the covered editor.
      if (document.querySelector('[aria-modal="true"]')) return;
      const run = resolve(event);
      if (!run) return;
      event.preventDefault();
      // Capture + stopImmediatePropagation: xterm, Monaco and the composer
      // never see a workbench shortcut, so the SAME key does the SAME thing on
      // every surface. Keys outside this table stay untouched.
      event.stopImmediatePropagation();
      run();
    };
    window.addEventListener("keydown", onShortcutCapture, true);
    // Event routes for surfaces that reach the workbench without a keystroke
    // (Monaco commands inside a modal diff, menus, mouse back/forward).
    const onCycle = (event: Event) => {
      const offset = Number((event as CustomEvent).detail) || 1;
      cycleTab(offset);
    };
    window.addEventListener("mixdog:cycle-tab", onCycle);
    const onSwitcher = (event: Event) => {
      const offset = Number((event as CustomEvent).detail) || 1;
      actionsRef.current.openTabSwitcher(offset);
    };
    window.addEventListener("mixdog:tab-switcher", onSwitcher);
    const onNavigateHistory = (event: Event) => {
      const offset = Number((event as CustomEvent).detail) || -1;
      if (offset < 0) actionsRef.current.navigateBack();
      else actionsRef.current.navigateForward();
    };
    window.addEventListener("mixdog:navigate-history", onNavigateHistory);
    return () => {
      window.removeEventListener("keydown", onShortcutCapture, true);
      window.removeEventListener("mixdog:cycle-tab", onCycle);
      window.removeEventListener("mixdog:tab-switcher", onSwitcher);
      window.removeEventListener("mixdog:navigate-history", onNavigateHistory);
    };
  }, []);
}

// Global workspace shortcuts, extracted from App.tsx. User-tuned bindings:
// mod+N new task · ctrl+Tab MRU switcher · ctrl+PageUp/PageDown cycle ·
// mod+Left/Right tab cycle (outside text editing) · alt+Left/Right pane focus ·
// mod+P Quick Open · shift+mod+P Command Palette ·
// mod+, settings · mod+B sidebar · mod+J panel · ctrl+` terminal ·
// shift+mod+B utility dock · shift+mod+F find in files · mod+W close.
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
  /** Ctrl+Tab: open/advance the MRU tab switcher (VS Code grammar). */
  openTabSwitcher: (offset: number) => void;
  /** Alt+Left/Right: move focus to the previous/next pane group. */
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
    const cycleTab = (offset: number) => {
      const { tabs, activeTabKey, navigateTab } = actionsRef.current;
      if (tabs.length < 2) return;
      const index = tabs.findIndex((tab) => tab.key === activeTabKey);
      const next = tabs[(index + offset + tabs.length) % tabs.length];
      if (next) navigateTab(next);
    };
    const onCloseCapture = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!(key === "q" && event.ctrlKey)
        || event.metaKey || event.shiftKey || event.altKey) return;
      // Save/discard and other modal confirmations own every key until they
      // settle, even if focus momentarily remains in the covered editor.
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      // Composer, xterm and Monaco may all consume keydown at their target.
      // Capture owns Ctrl+Q once, before any of those handlers can swallow or
      // re-emit it.
      event.stopImmediatePropagation();
      window.dispatchEvent(new window.CustomEvent("mixdog:close-active-tab"));
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Alt+Left/Right moves PANE focus (user: PANE 이동은 알트, 라벨 이동은
      // 컨트롤); history stays reachable via mixdog:navigate-history.
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        actionsRef.current.focusSiblingPane(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[aria-modal="true"]')) return;
      const plain = !event.shiftKey && !event.altKey;
      const key = event.key.toLowerCase();
      // Ctrl+Left/Right ALWAYS cycles the pane tabs (user: 컨트롤 좌우 = pane
      // 라벨 이동, 어느 서피스에서든 — Studio auto-focuses its prompt and a
      // content guard kept killing the shortcut there). Monaco and xterm are
      // not special-cased here: both consume Ctrl+Arrow themselves and arrive
      // with defaultPrevented, which the top of this handler already honors.
      // Plain composer fields trade Ctrl word-jump for tab cycling (Home/End
      // and plain arrows remain native).
      if (plain && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        cycleTab(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (key === "p" && !event.altKey) {
        event.preventDefault();
        if (event.shiftKey) actionsRef.current.openCommandPalette();
        else actionsRef.current.openQuickAccess();
        return;
      }
      if (key === "n" && plain) {
        event.preventDefault();
        actionsRef.current.startTask();
        return;
      }
      if (key === "," && plain) {
        event.preventDefault();
        actionsRef.current.openSettings();
        return;
      }
      if (key === "b" && plain) {
        event.preventDefault();
        actionsRef.current.toggleSidebar();
        return;
      }
      if (key === "b" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        actionsRef.current.toggleDock();
        return;
      }
      if (key === "f" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        actionsRef.current.openFindInFiles();
        return;
      }
      if (key === "j" && plain) {
        event.preventDefault();
        actionsRef.current.togglePanel();
        return;
      }
      if (event.key === "`" && plain) {
        event.preventDefault();
        actionsRef.current.openTerminalPanel();
        return;
      }
      if (key === "w" && plain) {
        event.preventDefault();
        // The workspace handles keyboard and pointer close through one path.
        window.dispatchEvent(new window.CustomEvent("mixdog:close-active-tab"));
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        actionsRef.current.openTabSwitcher(event.shiftKey ? -1 : 1);
        return;
      }
      if ((event.key === "PageDown" || event.key === "PageUp") && plain) {
        event.preventDefault();
        cycleTab(event.key === "PageDown" ? 1 : -1);
      }
    };
    // VS Code terminal.integrated.commandsToSkipShell / tmux prefix grammar:
    // tab and pane navigation is captured BEFORE xterm can swallow the
    // keydown, so the terminal keeps the caret for immediate typing while
    // Ctrl+←/→ (tabs) and Alt+←/→ (panes) still navigate. Monaco is included
    // too — tab/pane navigation outranks the editor's Ctrl+Arrow word-jump
    // (user priority: 커서는 자동으로 잡아주되 전환은 항상 동작).
    const onNavCapture = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".xterm, .monaco-editor")
        || target.closest('[aria-modal="true"]')) return;
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        actionsRef.current.focusSiblingPane(offset);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cycleTab(offset);
      }
    };
    window.addEventListener("keydown", onCloseCapture, true);
    window.addEventListener("keydown", onNavCapture, true);
    window.addEventListener("keydown", onKeyDown);
    // Monaco owns Ctrl+Tab/PageUp/PageDown, so the editor re-emits tab cycling
    // through this event while Ctrl+Arrow remains normal word navigation
    // outside the empty workspace.
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
      window.removeEventListener("keydown", onCloseCapture, true);
      window.removeEventListener("keydown", onNavCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mixdog:cycle-tab", onCycle);
      window.removeEventListener("mixdog:tab-switcher", onSwitcher);
      window.removeEventListener("mixdog:navigate-history", onNavigateHistory);
    };
  }, []);
}

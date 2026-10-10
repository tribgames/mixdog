// THE workbench keymap. One table, resolved in the CAPTURE phase, so every
// surface (xterm, Monaco, composer, Studio prompt) obeys the same bindings
// instead of swallowing them;
// user: 단축키는 우리 걸로 다 인터셉트해서 먼저 처리). Only an open modal
// outranks the table. User-tuned bindings:
// mod+N new task · ctrl+Tab MRU switcher · ctrl+PageUp/PageDown cycle ·
// mod+Left/Right tab traversal, crossing pane boundaries in visual order ·
// mod+Up/Down focus the pane directly above/below (both pairs stay with a
// focused code editor: word jumps and line scrolling are editing keys) ·
// mod+P Quick Open · shift+mod+P Command Palette ·
// mod+, settings · mod+B left sidebar · alt+mod+B right utility dock ·
// mod+J panel · mod+O expand/collapse all tool activity (not in a code
// editor or terminal) ·
// shift+mod+F find in files · mod+W and ctrl+Q close ·
// mod+F session search when no tab is open (surfaces keep their own find) ·
// mod+K and mod+/ command palette · mod+1..9 go to tab (9 = last) ·
// mod+[ / mod+] back/forward · shift+mod+[ / ] previous/next tab.
// Bracket, K and / chords stay with a focused code editor (indent, chords,
// comment toggle).
import { useEffect, useRef } from 'react';

import type { WorkspaceTab } from './navigation';
import { openSessionSearch } from './session-search';
import { modalDialogPresented } from './surface-input-focus';
import { toggleToolActivityExpandAll } from './tool-activity-expansion';

interface WorkspaceShortcutActions {
  tabs: WorkspaceTab[];
  activeTabKey: string;
  navigateTab: (tab: WorkspaceTab) => void;
  startTask: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
  toggleDock: () => void;
  togglePanel: () => void;
  openQuickAccess: () => void;
  openCommandPalette: () => void;
  openFindInFiles: () => void;
  /** Ctrl+Tab: open or advance the MRU tab switcher. */
  openTabSwitcher: (offset: number) => void;
  /** Move focus to the previous/next pane in visual row-major order. */
  focusSiblingPane: (offset: number) => void;
  /** Move focus to the nearest pane directly above/below. */
  focusVerticalPane: (direction: 'up' | 'down') => void;
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
      const next = crossPaneBoundary ? tabs[nextIndex] : tabs[(nextIndex + tabs.length) % tabs.length];
      if (next) navigateTab(next);
      else if (crossPaneBoundary) actionsRef.current.focusSiblingPane(offset);
    };
    const closeActiveTab = () => {
      // The workspace handles keyboard and pointer close through one path.
      window.dispatchEvent(new window.CustomEvent('mixdog:close-active-tab'));
    };
    /** The keymap itself: returns the command for an event, or null. */
    const resolve = (event: globalThis.KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return null;
      const key = event.key.toLowerCase();
      const plain = !event.shiftKey && !event.altKey;
      const target = event.target as Partial<Element> | null;
      const inEditor = Boolean(target?.closest?.('.monaco-editor'));
      if (plain && event.key.startsWith('Arrow') && inEditor) return null;
      if (!event.altKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
        if (inEditor) return null;
        const offset = event.code === 'BracketLeft' ? -1 : 1;
        if (event.shiftKey) return () => cycleTab(offset);
        return offset < 0 ? () => actionsRef.current.navigateBack() : () => actionsRef.current.navigateForward();
      }
      if (plain && (key === 'k' || key === '/')) {
        if (inEditor || target?.closest?.('.xterm')) return null;
        return () => actionsRef.current.openCommandPalette();
      }
      if (plain && /^[1-9]$/.test(event.key)) {
        const { tabs, navigateTab } = actionsRef.current;
        const tab = event.key === '9' ? tabs[tabs.length - 1] : tabs[Number(event.key) - 1];
        return tab ? () => navigateTab(tab) : null;
      }
      if (plain && key === 'f' && actionsRef.current.tabs.length === 0) return openSessionSearch;
      if (plain && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const offset = event.key === 'ArrowLeft' ? -1 : 1;
        return () => cycleTab(offset, true);
      }
      if (plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const direction = event.key === 'ArrowUp' ? 'up' : 'down';
        return () => actionsRef.current.focusVerticalPane(direction);
      }
      if (plain && (event.key === 'PageUp' || event.key === 'PageDown')) {
        const offset = event.key === 'PageDown' ? 1 : -1;
        return () => cycleTab(offset);
      }
      if (event.key === 'Tab' && !event.altKey) {
        const offset = event.shiftKey ? -1 : 1;
        return () => actionsRef.current.openTabSwitcher(offset);
      }
      if (key === 'p' && !event.altKey) {
        return event.shiftKey
          ? () => actionsRef.current.openCommandPalette()
          : () => actionsRef.current.openQuickAccess();
      }
      if (key === 'f' && event.shiftKey && !event.altKey) {
        return () => actionsRef.current.openFindInFiles();
      }
      // Ctrl+B = right utility dock, Ctrl+Shift+B = left side bar (user).
      if (key === 'b' && plain) return () => actionsRef.current.toggleDock();
      if (key === 'b' && event.shiftKey && !event.altKey) {
        return () => actionsRef.current.toggleSidebar();
      }
      if (!plain) return null;
      if (key === 'n') return () => actionsRef.current.startTask();
      if (key === ',') return () => actionsRef.current.openSettings();
      if (key === 'j') return () => actionsRef.current.togglePanel();
      if (key === 'o') {
        if (inEditor || target?.closest?.('.xterm')) return null;
        return toggleToolActivityExpandAll;
      }
      if (key === 'w' || key === 'q') return closeActiveTab;
      return null;
    };
    const onShortcutCapture = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // An IME composition owns its own keystrokes until it commits.
      if (event.isComposing || event.keyCode === 229) return;
      // Save/discard and other modal confirmations own every key until they
      // settle, even if focus momentarily remains in the covered editor. Only a
      // PRESENTED dialog counts: Settings and the command surfaces stay mounted
      // while parked, and treating those as modal killed the whole keymap.
      if (modalDialogPresented()) return;
      const run = resolve(event);
      if (!run) return;
      event.preventDefault();
      // Capture + stopImmediatePropagation: xterm, Monaco and the composer
      // never see a workbench shortcut, so the SAME key does the SAME thing on
      // every surface. Keys outside this table stay untouched.
      event.stopImmediatePropagation();
      run();
    };
    window.addEventListener('keydown', onShortcutCapture, true);
    // Event routes for surfaces that reach the workbench without a keystroke
    // (Monaco commands inside a modal diff, menus, mouse back/forward).
    const onCycle = (event: Event) => {
      const offset = Number((event as CustomEvent).detail) || 1;
      cycleTab(offset);
    };
    window.addEventListener('mixdog:cycle-tab', onCycle);
    const onSwitcher = (event: Event) => {
      const offset = Number((event as CustomEvent).detail) || 1;
      actionsRef.current.openTabSwitcher(offset);
    };
    window.addEventListener('mixdog:tab-switcher', onSwitcher);
    const onNavigateHistory = (event: Event) => {
      const offset = Number((event as CustomEvent).detail) || -1;
      if (offset < 0) actionsRef.current.navigateBack();
      else actionsRef.current.navigateForward();
    };
    window.addEventListener('mixdog:navigate-history', onNavigateHistory);
    return () => {
      window.removeEventListener('keydown', onShortcutCapture, true);
      window.removeEventListener('mixdog:cycle-tab', onCycle);
      window.removeEventListener('mixdog:tab-switcher', onSwitcher);
      window.removeEventListener('mixdog:navigate-history', onNavigateHistory);
    };
  }, []);
}

import { useEffect, useRef } from 'react';

import { stepUiScale } from './appearance/font-settings';
import type { WorkspaceTab } from './navigation';
import { openSessionSearch } from './session-search';
import { isTextNavigationTarget, modalDialogPresented } from './surface-input-focus';
import { toggleToolActivityExpandAll } from './tool-activity-expansion';
import { zoomTargetClaimsKey } from './zoom-target';

/** Surfaces with their own back/forward or word motion: the in-app browser and the terminal. */
const OWN_HISTORY_SURFACES = '.browser-pane, .browser-isolated-view, .xterm';

interface WorkspaceShortcutActions {
  tabs: WorkspaceTab[];
  activeTabKey: string;
  navigateTab: (tab: WorkspaceTab) => void;
  startTask: () => void;
  /** Ctrl+Alt+N: a new task with No project (this draft only). */
  startProjectlessTask: () => void;
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

type ActionsRef = { current: WorkspaceShortcutActions };

function cycleTab(actionsRef: ActionsRef, offset: number, crossPaneBoundary = false) {
  const { tabs, activeTabKey, navigateTab } = actionsRef.current;
  const index = tabs.findIndex((tab) => tab.key === activeTabKey);
  if (index < 0) return;
  const nextIndex = index + offset;
  const next = crossPaneBoundary ? tabs[nextIndex] : tabs[(nextIndex + tabs.length) % tabs.length];
  if (next) navigateTab(next);
  else if (crossPaneBoundary) actionsRef.current.focusSiblingPane(offset);
}
function closeActiveTab() {
  // The workspace handles keyboard and pointer close through one path.
  window.dispatchEvent(new window.CustomEvent('mixdog:close-active-tab'));
}
/** The keymap itself: returns the command for an event, or null. */
function resolveShortcut(event: globalThis.KeyboardEvent, actionsRef: ActionsRef) {
  const mod = event.ctrlKey || event.metaKey;
  const target = event.target as Partial<Element> | null;
  const inEditor = Boolean(target?.closest?.('.monaco-editor'));
  const ownsHistoryKeys = Boolean(target?.closest?.(OWN_HISTORY_SURFACES));
  // On macOS Option+Left/Right is word motion in text fields and Monaco; elsewhere Alt+Left/Right has no text meaning.
  if (event.altKey && !mod && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    if (ownsHistoryKeys) return null;
    if (/Mac/i.test(navigator.platform) && (inEditor || isTextNavigationTarget(event.target))) return null;
    return event.key === 'ArrowLeft'
      ? () => actionsRef.current.navigateBack()
      : () => actionsRef.current.navigateForward();
  }
  if (!mod) return null;
  const key = event.key.toLowerCase();
  const plain = !event.shiftKey && !event.altKey;
  if (plain && event.key.startsWith('Arrow') && inEditor) return null;
  // Matched by typed character before the bracket codes: some layouts type `+` on BracketRight.
  if (!event.altKey && (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0')) {
    if (ownsHistoryKeys || zoomTargetClaimsKey()) return null;
    let direction: -1 | 0 | 1 = 1;
    if (event.key === '-') direction = -1;
    else if (event.key === '0') direction = 0;
    return () => stepUiScale(direction);
  }
  if (!event.altKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
    if (inEditor) return null;
    const offset = event.code === 'BracketLeft' ? -1 : 1;
    if (event.shiftKey) return () => cycleTab(actionsRef, offset);
    // The browser page keeps its own back/forward; in a terminal Ctrl+[ is Escape.
    if (ownsHistoryKeys) return null;
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
  if (plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    // Cmd+Up/Down in a text field is the macOS jump to the start/end of the text.
    if (event.metaKey && target?.closest?.('textarea, input, [contenteditable="true"]')) return null;
    const direction = event.key === 'ArrowUp' ? 'up' : 'down';
    return () => actionsRef.current.focusVerticalPane(direction);
  }
  if (plain && (event.key === 'PageUp' || event.key === 'PageDown')) {
    const offset = event.key === 'PageDown' ? 1 : -1;
    return () => cycleTab(actionsRef, offset, true);
  }
  if (event.key === 'Tab' && !event.altKey) {
    const offset = event.shiftKey ? -1 : 1;
    return () => actionsRef.current.openTabSwitcher(offset);
  }
  if (key === 'p' && !event.altKey) {
    return event.shiftKey ? () => actionsRef.current.openCommandPalette() : () => actionsRef.current.openQuickAccess();
  }
  if (key === 'f' && event.shiftKey && !event.altKey) {
    return () => actionsRef.current.openFindInFiles();
  }
  // Ctrl+B = right utility dock, Ctrl+Shift+B = left side bar (user).
  if (key === 'b' && plain) return () => actionsRef.current.toggleDock();
  if (key === 'b' && event.shiftKey && !event.altKey) {
    return () => actionsRef.current.toggleSidebar();
  }
  // Ctrl+Alt+N = new task with no project. Where Ctrl+Alt is AltGr the key
  // types a character (Polish ń), so that layout keeps it.
  if (
    event.altKey &&
    !event.shiftKey &&
    (event.code === 'KeyN' || key === 'n') &&
    !event.getModifierState?.('AltGraph')
  ) {
    return () => actionsRef.current.startProjectlessTask();
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
}

export function useWorkspaceShortcuts(actions: WorkspaceShortcutActions) {
  // The listener binds once; every render refreshes the callbacks it reads so
  // a shortcut always acts on the current tab set.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onShortcutCapture = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // An IME composition owns its own keystrokes until it commits.
      if (event.isComposing || event.keyCode === 229) return;
      // Save/discard and other modal confirmations own every key until they
      // settle, even if focus momentarily remains in the covered editor. Only a
      // PRESENTED dialog counts: Settings and the command surfaces stay mounted
      // while parked, and treating those as modal killed the whole keymap.
      // The keymap is resolved first (it reads the event plus the zoom
      // targets, focus and hover): a plain keystroke matches nothing and never
      // asks about dialogs.
      const run = resolveShortcut(event, actionsRef);
      if (!run || modalDialogPresented()) return;
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
      cycleTab(actionsRef, offset);
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
    // Electron's `app-command` misses presses over page content and cannot be cancelled.
    const onMouseNavigate = (event: globalThis.MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      const target = event.target as Partial<Element> | null;
      if (target?.closest?.(OWN_HISTORY_SURFACES) || modalDialogPresented()) return;
      event.preventDefault();
      window.dispatchEvent(new window.CustomEvent('mixdog:navigate-history', { detail: event.button === 3 ? -1 : 1 }));
    };
    window.addEventListener('mouseup', onMouseNavigate, true);
    return () => {
      window.removeEventListener('mouseup', onMouseNavigate, true);
      window.removeEventListener('keydown', onShortcutCapture, true);
      window.removeEventListener('mixdog:cycle-tab', onCycle);
      window.removeEventListener('mixdog:tab-switcher', onSwitcher);
      window.removeEventListener('mixdog:navigate-history', onNavigateHistory);
    };
  }, []);
}

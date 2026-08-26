import { useRef, type Dispatch, type SetStateAction } from "react";
import type {
  NavigationSelection,
  WorkspaceSelection,
  WorkspaceTab,
} from "./navigation";

export function usePaneTabNavigation({
  focusedLeafId,
  activeTabKey,
  openSelectionInFocusedPane,
  setComposerFocusRequest,
  startTask,
  startProject,
  openSession,
}: {
  focusedLeafId: string;
  activeTabKey: string;
  openSelectionInFocusedPane(
    selection: WorkspaceSelection,
    replaceKey?: string,
    options?: { preview?: boolean },
  ): void;
  setComposerFocusRequest: Dispatch<SetStateAction<number>>;
  startTask(selection?: Extract<NavigationSelection, { kind: "new" }>): void;
  startProject(path: string): void;
  openSession(sessionId: string): void | Promise<void>;
}) {
  const paneTypingFocusGeneration = useRef(0);

  const focusPaneTypingSurface = (
    leafId: string,
    selection: WorkspaceSelection | null | undefined,
  ) => {
    if (!selection) return;
    if (selection.kind === "session" || selection.kind === "new"
      || selection.kind === "project") {
      setComposerFocusRequest((value) => value + 1);
      return;
    }
    const selector = selection.kind === "terminal"
      ? "[data-surface-active='true'] .xterm-helper-textarea"
      : selection.kind === "studio"
        ? "[data-surface-active='true'] textarea"
        : selection.kind === "file" || selection.kind === "diff"
          || selection.kind === "pull-request"
          ? "[data-surface-active='true'] .monaco-editor textarea.inputarea"
          : "";
    if (!selector) return;
    if (document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    const generation = ++paneTypingFocusGeneration.current;
    let tries = 600;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      detach();
    };
    const onKeyCancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Alt"
        || event.key === "Shift" || event.key === "Meta") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typingTarget = target && (target.tagName === "TEXTAREA"
        || target.tagName === "INPUT" || target.isContentEditable
        || target.closest(".xterm"));
      if (typingTarget) cancel();
    };
    const detach = () => {
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", onKeyCancel, true);
    };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", onKeyCancel, true);
    const attempt = () => {
      if (cancelled || generation !== paneTypingFocusGeneration.current) {
        detach();
        return;
      }
      const pane = document.querySelector<HTMLElement>(`[data-pane-id="${leafId}"]`);
      const target = pane
        ? [...pane.querySelectorAll<HTMLElement>(selector)]
          .find((element) => element.getClientRects().length > 0)
        : undefined;
      if (target) {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) {
          detach();
          return;
        }
      }
      if (tries-- > 0) {
        window.requestAnimationFrame(attempt);
        return;
      }
      detach();
    };
    window.requestAnimationFrame(attempt);
  };

  const navigateTab = (tab: WorkspaceTab) => {
    if (tab.selection.kind === "file"
      || tab.selection.kind === "studio"
      || tab.selection.kind === "terminal"
      || tab.selection.kind === "folder"
      || tab.selection.kind === "browser"
      || tab.selection.kind === "diff"
      || tab.selection.kind === "pull-request") {
      openSelectionInFocusedPane(tab.selection);
      focusPaneTypingSurface(focusedLeafId, tab.selection);
      return;
    }
    setComposerFocusRequest((value) => value + 1);
    if (tab.key === activeTabKey) return;
    if (tab.selection.kind === "new") startTask(tab.selection);
    else if (tab.selection.kind === "project") startProject(tab.selection.path);
    else void openSession(tab.selection.id);
  };

  return { focusPaneTypingSurface, navigateTab };
}

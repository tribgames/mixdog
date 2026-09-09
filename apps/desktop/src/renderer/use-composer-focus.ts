import { useEffect, useRef, type RefObject } from "react";
import { isRemoteBrowserRenderer } from "./remote-ui-projection";
import { modalDialogPresented, shouldFocusComposerFromWindowKey, surfaceOwnsKeyboard, touchPrimaryPointer } from "./surface-input-focus";

/** Browser focus can raise the keyboard or move the viewport even with
 *  preventScroll. Only the native, non-touch shell pre-focuses the composer;
 *  browser users focus it by tapping the field or starting to type. */
function scheduleComposerAutoFocus(
  textarea: RefObject<HTMLTextAreaElement | null>,
  preserveTyping = false,
): (() => void) | undefined {
  if (isRemoteBrowserRenderer() || touchPrimaryPointer()) return undefined;
  const timer = window.setTimeout(() => {
    const target = textarea.current;
    if (!target || !document.hasFocus() || target.closest("[inert]")
      || modalDialogPresented()) return;
    const active = document.activeElement;
    if (active?.classList.contains("session-header-title-input")) return;
    if (preserveTyping && surfaceOwnsKeyboard(active)) return;
    target.focus({ preventScroll: true });
  }, 0);
  return () => window.clearTimeout(timer);
}

export function useComposerFocus({
  textarea,
  transitioning,
  focusRequest,
  paneActive,
}: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  transitioning: boolean;
  focusRequest: number;
  paneActive: boolean;
}): void {
  const wasTransitioning = useRef(transitioning);
  const handledFocusRequest = useRef(0);
  useEffect(() => {
    const settled = wasTransitioning.current && !transitioning;
    wasTransitioning.current = transitioning;
    if (settled && paneActive) return scheduleComposerAutoFocus(textarea, true);
    return undefined;
  }, [textarea, transitioning, paneActive]);
  useEffect(() => {
    if (focusRequest <= handledFocusRequest.current) return undefined;
    handledFocusRequest.current = focusRequest;
    if (transitioning || !paneActive) return undefined;
    return scheduleComposerAutoFocus(textarea);
  }, [textarea, focusRequest, transitioning, paneActive]);
  useEffect(() => paneActive ? scheduleComposerAutoFocus(textarea, true) : undefined, [textarea, paneActive]);
  useEffect(() => {
    if (!paneActive || transitioning || isRemoteBrowserRenderer() || touchPrimaryPointer()) return undefined;
    let cancel: (() => void) | undefined;
    const restoreFocus = () => {
      cancel?.();
      cancel = scheduleComposerAutoFocus(textarea, true);
    };
    window.addEventListener("focus", restoreFocus);
    return () => {
      window.removeEventListener("focus", restoreFocus);
      cancel?.();
    };
  }, [textarea, paneActive, transitioning]);
}

/** Move focus during keydown capture, before the browser commits the first
 *  character or starts IME composition. Do not cancel or replay the key. */
export function usePaneTypingFocus(
  focusedLeafId: string,
  selectionKind: string | undefined,
): void {
  useEffect(() => {
    const focusComposerForTyping = (event: KeyboardEvent) => {
      const typingSurfaceSelector = selectionKind === "studio"
        ? ".studio-root[data-surface-active='true'] textarea"
        : selectionKind === "session" || selectionKind === "new"
          ? "form.composer textarea"
          : "";
      if (!typingSurfaceSelector) return;
      if (!shouldFocusComposerFromWindowKey(event)) return;
      const pane = document.querySelector<HTMLElement>(`[data-pane-id="${focusedLeafId}"]`);
      const typingSurface = pane?.querySelector<HTMLTextAreaElement>(typingSurfaceSelector);
      if (!typingSurface || typingSurface.closest("[inert]")) return;
      typingSurface.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", focusComposerForTyping, true);
    return () => window.removeEventListener("keydown", focusComposerForTyping, true);
  }, [selectionKind, focusedLeafId]);
}

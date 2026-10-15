import { useEffect, useRef, type RefObject } from 'react';
import { isMobileRemoteSurface } from './mobile-surface';
import {
  modalDialogPresented,
  shouldFocusComposerFromWindowKey,
  surfaceOwnsKeyboard,
  touchPrimaryPointer,
} from './surface-input-focus';

/** On a touch or phone surface, focus raises the on-screen keyboard or moves
 *  the viewport even with preventScroll, so there the user focuses the field
 *  by tapping it. Keyboard-and-pointer surfaces (the desktop window, a PC
 *  browser tab, an other-PC window) pre-focus the composer alike. */
function composerAutoFocusBlocked(): boolean {
  return touchPrimaryPointer() || isMobileRemoteSurface();
}

function scheduleComposerAutoFocus(
  textarea: RefObject<HTMLTextAreaElement | null>,
  preserveTyping = false
): (() => void) | undefined {
  if (composerAutoFocusBlocked()) return undefined;
  const timer = window.setTimeout(() => {
    const target = textarea.current;
    if (!target || !document.hasFocus() || target.closest('[inert]') || modalDialogPresented()) return;
    const active = document.activeElement;
    // A rename editor (header or tab strip) opened by the same press that asked
    // for composer focus keeps the caret; stealing it would blur-commit the draft.
    if (active?.matches('.session-header-title-input, .workspace-tab-title-input')) return;
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
  useEffect(() => (paneActive ? scheduleComposerAutoFocus(textarea, true) : undefined), [textarea, paneActive]);
  useEffect(() => {
    if (!paneActive || transitioning || composerAutoFocusBlocked()) return undefined;
    let cancel: (() => void) | undefined;
    const restoreFocus = () => {
      cancel?.();
      cancel = scheduleComposerAutoFocus(textarea, true);
    };
    window.addEventListener('focus', restoreFocus);
    return () => {
      window.removeEventListener('focus', restoreFocus);
      cancel?.();
    };
  }, [textarea, paneActive, transitioning]);
}

/** Move focus during keydown capture, before the browser commits the first
 *  character or starts IME composition. Do not cancel or replay the key. */
export function usePaneTypingFocus(focusedLeafId: string, selectionKind: string | undefined): void {
  useEffect(() => {
    const focusComposerForTyping = (event: KeyboardEvent) => {
      let typingSurfaceSelector = '';
      if (selectionKind === 'studio') typingSurfaceSelector = ".studio-root[data-surface-active='true'] textarea";
      else if (selectionKind === 'session' || selectionKind === 'new') typingSurfaceSelector = 'form.composer textarea';
      if (!typingSurfaceSelector) return;
      if (!shouldFocusComposerFromWindowKey(event)) return;
      const pane = document.querySelector<HTMLElement>(`[data-pane-id="${focusedLeafId}"]`);
      const typingSurface = pane?.querySelector<HTMLTextAreaElement>(typingSurfaceSelector);
      if (!typingSurface || typingSurface.closest('[inert]')) return;
      typingSurface.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', focusComposerForTyping, true);
    return () => window.removeEventListener('keydown', focusComposerForTyping, true);
  }, [selectionKind, focusedLeafId]);
}

import type { MouseEvent as ReactMouseEvent } from "react";

const SURFACE_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "label",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='dialog']",
  "[role='link']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
].join(",");

const SURFACE_KEYBOARD_OWNER_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  ".xterm",
  ".monaco-editor",
  "[role='dialog']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='option']",
].join(",");

/** Touch-first device (phone/tablet): the primary pointer is coarse. On these
 *  surfaces a programmatic focus raises the software keyboard, so
 *  click-anywhere/auto focus grammars must stand down and let only a direct
 *  tap on the field open the keyboard (user: 터치만 해도 키보드가 올라옴). */
export function touchPrimaryPointer(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
}

export function shouldFocusSurfaceInput(
  event: ReactMouseEvent<HTMLElement>,
  ignoredNearestInteractiveSelector = "",
): boolean {
  if (event.button !== 0 || event.defaultPrevented) return false;
  if (touchPrimaryPointer()) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(SURFACE_INTERACTIVE_SELECTOR);
  if (interactive
    && (!ignoredNearestInteractiveSelector
      || !interactive.matches(ignoredNearestInteractiveSelector))) return false;
  const selection = window.getSelection?.();
  return !selection || selection.isCollapsed;
}

export function shouldFocusComposerFromWindowKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key.length !== 1 && event.key !== "Process" && event.key !== "Dead") return false;
  if (document.querySelector('[aria-modal="true"]')) return false;
  const target = event.target;
  return !(target instanceof Element) || !target.closest(SURFACE_KEYBOARD_OWNER_SELECTOR);
}

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

export function shouldFocusSurfaceInput(event: ReactMouseEvent<HTMLElement>): boolean {
  if (event.button !== 0 || event.defaultPrevented) return false;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(SURFACE_INTERACTIVE_SELECTOR)) return false;
  const selection = window.getSelection?.();
  return !selection || selection.isCollapsed;
}

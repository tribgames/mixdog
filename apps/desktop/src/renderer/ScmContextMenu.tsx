// Row context menus for the Source Control dock — GitHub Desktop's right-click
// grammar (app/src/ui/changes/changed-file.tsx and app/src/ui/history's commit
// context menus): ONE flat menu of labelled actions, opened by the right
// button or by the keyboard (Menu / Shift+F10), dismissed by Escape, an
// outside click, a resize or a scroll. The per-row "…" trigger buttons the
// dock used to carry are gone; this menu replaces them.
import { Check } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ScmContextMenuItem {
  /** Stable semantic action identity; labels and enabled state may update in place. */
  id: string;
  label: string;
  onSelect?(): void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  /** Renders the item as a radio entry (View & Sort). */
  checked?: boolean;
  /** Tooltip; on a DISABLED item this is the reason it cannot run yet. */
  title?: string;
}

export interface ScmContextMenuState {
  /** Accessible name AND the open-menu identity (drives aria-expanded). */
  label: string;
  x: number;
  y: number;
  items: ScmContextMenuItem[];
}

/** Pointer position of a right-click. */
export function pointerMenuPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  return { x: event.clientX, y: event.clientY };
}

/** Keyboard invocation has no pointer, so the menu opens under the ROW
 *  (GitHub Desktop anchors its keyboard menus to the focused item). */
export function elementMenuPoint(element: Element | null): { x: number; y: number } {
  const rect = element?.getBoundingClientRect?.();
  return { x: (rect?.left ?? 0) + 8, y: rect?.bottom ?? 0 };
}

/** True for the two shortcuts every platform maps to "open the context menu". */
export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

export function ScmContextMenu({
  state,
  onClose,
}: {
  state: ScmContextMenuState | null;
  onClose(): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", left: 0, top: 0 });
  const open = Boolean(state);
  const x = state?.x ?? 0;
  const y = state?.y ?? 0;

  // Clamped against the window, exactly like the dock's other overlays: the
  // dock hugs the window edge, so a menu opened at the pointer would otherwise
  // run off-screen (anchored-panel.ts keeps the same rule for the panels).
  useLayoutEffect(() => {
    if (!open) return;
    const surface = panel.current;
    const width = surface?.offsetWidth || 0;
    const height = surface?.scrollHeight || surface?.offsetHeight || 0;
    const viewportWidth = window.innerWidth || 0;
    const viewportHeight = window.innerHeight || 0;
    const left = width && viewportWidth
      ? Math.max(8, Math.min(x, viewportWidth - width - 8))
      : x;
    const top = height && viewportHeight && y + height > viewportHeight - 8
      ? Math.max(8, y - height)
      : y;
    setStyle({
      position: "fixed",
      left,
      top,
      ...(viewportHeight ? { maxHeight: Math.max(120, viewportHeight - 16) } : {}),
    });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return undefined;
    // Keyboard users land ON the menu; closing hands focus back to the row.
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => panel.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled),"
        + " [role='menuitemradio']:not(:disabled)")?.focus());
    const dismiss = (event: Event) => {
      if (panel.current?.contains(event.target as Node)) return;
      onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The dock's other Escape handlers (branch panel, row selection) must
      // not fire on the keystroke that only closed this menu.
      event.stopPropagation();
      onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      if (previous?.isConnected) previous.focus?.();
    };
  }, [onClose, open]);

  if (!state) return null;

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(panel.current?.querySelectorAll<HTMLButtonElement>(
      "[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled)") || [])];
    if (!entries.length) return;
    const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
    let next = -1;
    if (event.key === "ArrowDown") next = (current + 1) % entries.length;
    else if (event.key === "ArrowUp") next = (current - 1 + entries.length) % entries.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = entries.length - 1;
    else if (event.key === "Tab") {
      onClose();
      return;
    } else return;
    event.preventDefault();
    entries[next]?.focus();
  };

  return createPortal(<div className="dock-scm-context-menu" role="menu" ref={panel}
    aria-label={state.label} style={style} onKeyDown={onMenuKeyDown}
    onContextMenu={(event) => event.preventDefault()}>
    {state.items.map((item) => <button type="button" key={item.id}
      data-action-id={item.id}
      role={item.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={item.checked}
      className={[
        item.danger ? "danger" : "",
        item.separatorBefore ? "menu-separator" : "",
      ].filter(Boolean).join(" ") || undefined}
      disabled={item.disabled}
      title={item.title}
      onClick={() => {
        onClose();
        item.onSelect?.();
      }}>
      <span className="dock-scm-context-check">
        {item.checked && <Check size={12} aria-hidden="true" />}
      </span>
      <span className="dock-scm-context-label">{item.label}</span>
    </button>)}
  </div>, document.body);
}

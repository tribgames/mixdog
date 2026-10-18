// Row context menus for the Source Control dock — the right-click
// grammar shared by changed-file rows and commit
// context menus: ONE flat menu of labelled actions, opened by the right
// button or by the keyboard (Menu / Shift+F10), dismissed by Escape, an
// outside click, a resize or a scroll. The per-row "…" trigger buttons the
// dock used to carry are gone; this menu replaces them.
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { RailPinIcon } from './RailPinIcon';

const ENABLED_MENU_ITEM_SELECTOR =
  "[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled), [role='menuitemcheckbox']:not(:disabled)";

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
  checkRole?: 'menuitemradio' | 'menuitemcheckbox';
  /** Tooltip; on a DISABLED item this is the reason it cannot run yet. */
  title?: string;
  icon?: React.ReactNode;
  active?: boolean;
  pinned?: boolean;
  /** A separate pin control keeps the destination menu open. */
  onTogglePin?(): void;
  /** Opens a second level in place of the menu (with a Back row on top). */
  children?: ScmContextMenuItem[];
}

/** Item tooltip: the blocking reason when there is one, else the missing-channel note for an unsupported action. */
export function actionTitle(blocked: string | undefined, capable: boolean, missing: () => string): string | undefined {
  if (blocked) return blocked;
  return capable ? undefined : missing();
}

export interface ScmContextMenuState {
  /** Accessible name AND the open-menu identity (drives aria-expanded). */
  label: string;
  /** Optional visible caption above the items; not focusable or selectable. */
  heading?: string;
  x: number;
  y: number;
  /** Right-align the menu to x (a menu anchored under a trailing button). */
  alignEnd?: boolean;
  /** Edge the menu flips above when it would overflow below (defaults to y). */
  flipY?: number;
  items: ScmContextMenuItem[];
}

/** Pointer position of a right-click. */
export function pointerMenuPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  return { x: event.clientX, y: event.clientY };
}

/** Keyboard invocation has no pointer, so the menu opens under the ROW
 *  (keyboard menus anchor to the focused item). */
export function elementMenuPoint(element: Element | null): { x: number; y: number } {
  const rect = element?.getBoundingClientRect?.();
  return { x: (rect?.left ?? 0) + 8, y: rect?.bottom ?? 0 };
}

/** True for the two shortcuts every platform maps to "open the context menu". */
export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

/** Row handlers that open a context menu: at the pointer on right-click, under
 *  the row on Menu / Shift+F10. */
export function contextMenuRowProps(open: (point: { x: number; y: number }) => void) {
  return {
    onContextMenu(event: React.MouseEvent<HTMLElement>) {
      event.preventDefault();
      open(pointerMenuPoint(event));
    },
    onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      open(elementMenuPoint(event.currentTarget));
    },
  };
}

/** Clamped against the window, exactly like the dock's other overlays: the
 *  dock hugs the window edge, so a menu opened at the pointer would otherwise
 *  run off-screen (anchored-panel.ts keeps the same rule for the panels). */
function menuPosition(
  surface: HTMLElement | null,
  x: number,
  y: number,
  alignEnd = false,
  flipY = y
): React.CSSProperties {
  const width = surface?.offsetWidth || 0;
  const height = surface?.scrollHeight || surface?.offsetHeight || 0;
  const viewportWidth = window.innerWidth || 0;
  const viewportHeight = window.innerHeight || 0;
  const start = alignEnd ? x - width : x;
  const left = width && viewportWidth ? Math.max(8, Math.min(start, viewportWidth - width - 8)) : start;
  const top = height && viewportHeight && y + height > viewportHeight - 8 ? Math.max(8, flipY - height) : y;
  return {
    position: 'fixed',
    left,
    top,
    ...(viewportHeight ? { maxHeight: Math.max(120, viewportHeight - 16) } : {}),
  };
}

/** One menu entry: its action button, plus the separate pin control when it has one. */
function ScmContextMenuRow({
  item,
  onActivate,
}: {
  item: ScmContextMenuItem;
  onActivate(item: ScmContextMenuItem): void;
}) {
  const hasChildren = Boolean(item.children?.length);
  const action = (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is menuitemradio/menuitemcheckbox whenever checked is defined
    <button
      type="button"
      data-action-id={item.id}
      role={item.checked === undefined ? 'menuitem' : (item.checkRole ?? 'menuitemradio')}
      aria-checked={item.checked}
      aria-current={item.active ? 'page' : undefined}
      className={
        [item.danger ? 'danger' : '', item.separatorBefore ? 'menu-separator' : '', item.active ? 'active' : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      disabled={item.disabled}
      aria-haspopup={hasChildren ? 'menu' : undefined}
      title={item.title}
      onClick={() => onActivate(item)}
    >
      <span className={`dock-scm-context-check${item.icon ? ' is-icon' : ''}`}>
        {item.icon ?? (item.checked && <Check size={12} aria-hidden="true" />)}
      </span>
      <span className="dock-scm-context-label">{item.label}</span>
      {hasChildren && <ChevronRight size={12} aria-hidden="true" />}
    </button>
  );
  if (!item.onTogglePin) return action;
  return (
    <div className="dock-scm-context-menu-row" role="none">
      {action}
      <button
        type="button"
        className="dock-scm-context-pin"
        data-pin-id={item.id}
        role="menuitemcheckbox"
        aria-checked={item.pinned}
        aria-label={`${item.pinned ? t('Unpin') : t('Pin')}: ${item.label}`}
        title={item.pinned ? t('Unpin') : t('Pin')}
        onClick={item.onTogglePin}
      >
        <RailPinIcon pinned={Boolean(item.pinned)} size={14} />
      </button>
    </div>
  );
}

export function ScmContextMenu({
  state,
  onClose,
  anchorRef,
}: {
  state: ScmContextMenuState | null;
  onClose(): void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', left: 0, top: 0 });
  const open = Boolean(state);
  // Id of the submenu item whose children are showing; a new menu starts at the root.
  const [submenuId, setSubmenuId] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: state identity is the trigger
  useEffect(() => setSubmenuId(''), [state]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each submenu level refocuses its first item
  useEffect(() => {
    if (open)
      queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR)?.focus());
  }, [open, submenuId]);
  const x = state?.x ?? 0;
  const y = state?.y ?? 0;

  // Opening or leaving a submenu swaps the rendered items and so resizes the
  // panel; placement is measured again so the taller list stays on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: submenuId changes the measured panel size
  useLayoutEffect(() => {
    if (!open) return;
    setStyle(menuPosition(panel.current, x, y, state?.alignEnd, state?.flipY));
  }, [open, x, y, submenuId, state]);

  useEffect(() => {
    if (!open) return undefined;
    // Keyboard users land ON the menu; closing hands focus back to the row.
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR)?.focus());
    const dismiss = (event: Event) => {
      if (panel.current?.contains(event.target as Node) || anchorRef?.current?.contains(event.target as Node)) return;
      onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The dock's other Escape handlers (branch panel, row selection) must
      // not fire on the keystroke that only closed this menu.
      event.stopPropagation();
      onClose();
    };
    const close = () => onClose();
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      if (previous?.isConnected) previous.focus?.();
    };
  }, [onClose, open, anchorRef]);

  // ABB: hardware back closes the menu instead of leaving the PWA.
  useMobileBack(open, onClose);

  if (!state) return null;

  const submenuParent = submenuId ? state.items.find((item) => item.id === submenuId) : undefined;
  const visibleItems: ScmContextMenuItem[] = submenuParent?.children
    ? [
        { id: '__back', label: t('Back'), icon: <ChevronLeft size={12} aria-hidden="true" /> },
        ...submenuParent.children,
      ]
    : state.items;

  const activate = (item: ScmContextMenuItem) => {
    if (item.id === '__back') {
      setSubmenuId('');
      return;
    }
    if (item.children?.length) {
      setSubmenuId(item.id);
      return;
    }
    onClose();
    item.onSelect?.();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(panel.current?.querySelectorAll<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR) || [])];
    if (!entries.length) return;
    const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
    let next = -1;
    if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else if (event.key === 'Tab') {
      onClose();
      return;
    } else return;
    event.preventDefault();
    entries[next]?.focus();
  };

  return createPortal(
    <div
      className="dock-scm-context-menu"
      role="menu"
      ref={panel}
      aria-label={state.label}
      style={style}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {state.heading && (
        <div className="dock-scm-context-heading" role="presentation">
          {state.heading}
        </div>
      )}
      {visibleItems.map((item) => (
        <ScmContextMenuRow key={item.id} item={item} onActivate={activate} />
      ))}
    </div>,
    document.body
  );
}

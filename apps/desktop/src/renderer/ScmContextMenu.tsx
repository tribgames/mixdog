import { Check, ChevronRight } from 'lucide-react';
import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { closeOnUserScroll } from './menu-dismiss';
import { useMobileBack } from './mobile-back';
import { RailPinIcon } from './RailPinIcon';
import { type Submenu, SubmenuPanel, useSubmenu } from './submenu';

export const ENABLED_MENU_ITEM_SELECTOR =
  "[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled), [role='menuitemcheckbox']:not(:disabled)";

export interface ScmContextMenuItem {
  /** Stable semantic action identity; labels and enabled state may update in place. */
  id: string;
  label: string;
  onSelect?(): void;
  /** Open intent (hover, focus, press): prepares what selecting it shows. */
  onPrefetch?(): void;
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
  /** A submenu that opens beside the item. */
  children?: Omit<ScmContextMenuItem, 'children'>[];
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
  submenu,
  onActivate,
}: {
  item: ScmContextMenuItem;
  /** The menu level's submenus; absent inside a submenu. */
  submenu?: Submenu<string>;
  onActivate(item: ScmContextMenuItem): void;
}) {
  const opener = item.children?.length && submenu ? submenu.trigger(item.id, item.disabled) : null;
  const intent = opener ?? submenu?.item();
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
      title={item.title}
      {...intent}
      onPointerEnter={(event) => {
        item.onPrefetch?.();
        intent?.onPointerEnter(event);
      }}
      onFocus={(event) => {
        item.onPrefetch?.();
        intent?.onFocus(event);
      }}
      onPointerDown={(event) => {
        if (event.button === 0) item.onPrefetch?.();
      }}
      onClick={opener ? opener.onClick : () => onActivate(item)}
    >
      <span className={`dock-scm-context-check${item.icon ? ' is-icon' : ''}`}>
        {item.icon ?? (item.checked && <Check size={12} aria-hidden="true" />)}
      </span>
      <span className="dock-scm-context-label">{item.label}</span>
      {opener && <ChevronRight size={12} aria-hidden="true" />}
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
        {...submenu?.item()}
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
  const subPanel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', left: 0, top: 0 });
  const open = Boolean(state);
  // Id of the item whose submenu is open; a new menu starts with none.
  const [submenuId, setSubmenuId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: state identity is the trigger
  useEffect(() => setSubmenuId(null), [state]);
  const submenu = useSubmenu<string>({
    menuOpen: open,
    openKey: submenuId,
    open: setSubmenuId,
    close: () => setSubmenuId(null),
    panel: () => subPanel.current,
  });
  const x = state?.x ?? 0;
  const y = state?.y ?? 0;

  useLayoutEffect(() => {
    if (!open) return;
    setStyle(menuPosition(panel.current, x, y, state?.alignEnd, state?.flipY));
  }, [open, x, y, state]);

  // Owners may pass a fresh onClose on every render (a live agent update
  // re-renders them): read it through a ref, so only the open transition
  // re-arms the listeners and moves focus, never a re-render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const onClose = () => closeRef.current();
    // Keyboard users land ON the menu; closing hands focus back to the row.
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR)?.focus());
    const inside = (target: Node | null) =>
      Boolean(panel.current?.contains(target) || subPanel.current?.contains(target));
    const dismiss = (event: Event) => {
      if (inside(event.target as Node) || anchorRef?.current?.contains(event.target as Node)) return;
      onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The dock's other Escape handlers (branch panel, row selection) must
      // not fire on the keystroke that only closed this menu or its submenu.
      event.stopPropagation();
      if (!submenu.escape()) onClose();
    };
    const close = () => onClose();
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    const stopScrollDismiss = closeOnUserScroll(close, inside);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      stopScrollDismiss();
      if (previous?.isConnected) previous.focus?.();
    };
  }, [open, anchorRef, submenu]);

  // ABB: hardware back closes the menu instead of leaving the PWA.
  useMobileBack(open, onClose);

  if (!state) return null;

  const activate = (item: ScmContextMenuItem) => {
    onClose();
    item.onSelect?.();
  };
  const parent = state.items.find((item) => item.id === submenuId);
  const children = parent?.children;

  // Roving focus over the items of the panel (menu or submenu) the key was pressed in.
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR)];
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
      {state.items.map((item) => (
        <ScmContextMenuRow key={item.id} item={item} submenu={submenu} onActivate={activate} />
      ))}
      {parent && children?.length ? (
        <SubmenuPanel
          anchor={submenu.element(parent.id)}
          panelRef={subPanel}
          className="dock-scm-context-menu"
          label={parent.label}
          onKeyDown={onMenuKeyDown}
        >
          {children.map((item) => (
            <ScmContextMenuRow key={item.id} item={item} onActivate={activate} />
          ))}
        </SubmenuPanel>
      ) : null}
    </div>,
    document.body
  );
}

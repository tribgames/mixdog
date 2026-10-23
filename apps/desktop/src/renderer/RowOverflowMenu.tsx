import { Check, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { t } from './i18n';
import { closeOnUserScroll, useMenuDismiss } from './menu-dismiss';
import { useMobileBack } from './mobile-back';
import { useSurfaceActive } from './surface-activity';
import { captureRowMenuAnchor, positionRowMenu, useRowMenuClamp } from './row-menu-geometry';
import { isContextMenuKey, pointerMenuPoint } from './ScmContextMenu';

type RowOverflowMenuItem = {
  /** Stable semantic action identity; labels may change while the menu stays open. */
  id: string;
  label: string;
  onSelect?(): void;
  disabled?: boolean;
  /** Native tooltip, e.g. why the item is disabled. */
  title?: string;
  danger?: boolean;
  closeOnSelect?: boolean;
  checked?: boolean;
  /** A `checked` item that is one choice of a set: exposed as a radio. */
  radio?: boolean;
  separatorBefore?: boolean;
  children?: RowOverflowMenuItem[];
};

/** Focusable entries: actions and check items alike. */
const MENU_ENTRY =
  "[role='menuitem']:not(:disabled), [role='menuitemcheckbox']:not(:disabled), [role='menuitemradio']:not(:disabled)";

type RowOverflowOpener = (point?: { x: number; y: number }) => void;
/** Each mounted menu registers its opener under its trigger button. */
const rowOverflowOpeners = new WeakMap<Element, RowOverflowOpener>();

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)));
}

function requestRowOverflowOpen(host: HTMLElement, point?: { x: number; y: number }): boolean {
  const opener = rowOverflowOpeners.get(host.querySelector('.row-overflow-trigger') as Element);
  opener?.(point);
  return Boolean(opener);
}

/** Props for a host element (row/header) that contains a RowOverflowMenu: a
 *  right-click opens that menu at the pointer, and Menu / Shift+F10 opens it at
 *  its trigger. Editable targets keep the native context menu. */
export function rowOverflowHostProps() {
  return {
    onContextMenu(event: MouseEvent<HTMLElement>) {
      if (isEditableTarget(event.target)) return;
      if (requestRowOverflowOpen(event.currentTarget, pointerMenuPoint(event))) {
        event.preventDefault();
      }
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (!isContextMenuKey(event)) return;
      if (isEditableTarget(event.target)) return;
      if (requestRowOverflowOpen(event.currentTarget)) event.preventDefault();
    },
  };
}

/** An open menu closes on an outside pointer, on Escape (which returns focus
 *  to the trigger), on Tab (menu-dismiss.ts) and on anything that moves it:
 *  resize or a user scroll (closeOnUserScroll). */
function useRowOverflowDismiss({
  menuOpen,
  path,
  panel,
  trigger,
  setOpen,
}: {
  menuOpen: boolean;
  path: number[];
  panel: RefObject<HTMLDivElement | null>;
  trigger: RefObject<HTMLButtonElement | null>;
  setOpen(open: boolean): void;
}): void {
  useMenuDismiss({ open: menuOpen, close: () => setOpen(false), trigger, panels: () => [panel.current] });
  // biome-ignore lint/correctness/useExhaustiveDependencies: panel is a ref and setOpen a useState setter (both stable); path is a deliberate trigger that refocuses the first item on each submenu level.
  useEffect(() => {
    if (!menuOpen) return undefined;
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(MENU_ENTRY)?.focus());
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    const stopScrollDismiss = closeOnUserScroll(close, (target) => Boolean(panel.current?.contains(target)));
    return () => {
      window.removeEventListener('resize', close);
      stopScrollDismiss();
    };
  }, [menuOpen, path]);
}

/** Roving focus inside the open menu; Left/Right walk the submenu levels. */
function rowOverflowMenuKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  {
    panel,
    path,
    setPath,
  }: {
    panel: RefObject<HTMLDivElement | null>;
    path: number[];
    setPath(update: (current: number[]) => number[]): void;
  }
): void {
  const entries = [...(panel.current?.querySelectorAll<HTMLButtonElement>(MENU_ENTRY) || [])];
  if (!entries.length) return;
  const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
  let next = -1;
  if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
  else if (event.key === 'ArrowRight') {
    const active = document.activeElement as HTMLButtonElement;
    if (active?.dataset.submenu === 'true') active.click();
    return;
  } else if (event.key === 'ArrowLeft' && path.length) {
    event.preventDefault();
    setPath((currentPath) => currentPath.slice(0, -1));
    return;
  } else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = entries.length - 1;
  else return;
  event.preventDefault();
  entries[next]?.focus();
}

function renderRowOverflowItem({
  item,
  index,
  hasCheckItems,
  setPath,
  setOpen,
}: {
  item: RowOverflowMenuItem;
  index: number;
  hasCheckItems: boolean;
  setPath(update: (current: number[]) => number[]): void;
  setOpen(open: boolean): void;
}) {
  const submenu = Boolean(item.children?.length);
  // Action labels can change in place (Delete → Confirm delete). Keep the
  // positional action node stable so focus, hover, and flex layout do not
  // reset while the open menu confirms a destructive action.
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is only set when role is menuitemcheckbox; the role is dynamic.
    <button
      key={item.id}
      type="button"
      data-action-id={item.id}
      role={item.checked === undefined ? 'menuitem' : item.radio ? 'menuitemradio' : 'menuitemcheckbox'}
      aria-checked={item.checked === undefined ? undefined : item.checked}
      aria-haspopup={submenu ? 'menu' : undefined}
      data-submenu={submenu ? 'true' : undefined}
      className={
        [item.danger ? 'danger' : '', item.separatorBefore ? 'menu-separator' : ''].filter(Boolean).join(' ') ||
        undefined
      }
      disabled={item.disabled}
      title={item.title}
      onClick={() => {
        if (submenu) {
          setPath((current) => [...current, index]);
          return;
        }
        item.onSelect?.();
        if (item.closeOnSelect !== false) setOpen(false);
      }}
    >
      {hasCheckItems && (
        <span className="row-overflow-check">{item.checked && <Check size={14} aria-hidden="true" />}</span>
      )}
      <span className="row-overflow-label">{item.label}</span>
      {submenu && <ChevronRight className="row-overflow-submenu" size={14} aria-hidden="true" />}
    </button>
  );
}

function renderRowOverflowPanel({
  panel,
  label,
  path,
  menuItems,
  hasCheckItems,
  placement,
  onKeyDown,
  setPath,
  setOpen,
}: {
  panel: RefObject<HTMLDivElement | null>;
  label: string;
  path: number[];
  menuItems: RowOverflowMenuItem[];
  hasCheckItems: boolean;
  placement: ReturnType<typeof positionRowMenu>;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  setPath(update: (current: number[]) => number[]): void;
  setOpen(open: boolean): void;
}) {
  return createPortal(
    <div
      ref={panel}
      className="row-overflow-menu"
      role="menu"
      aria-label={t('{{label}} menu', { label })}
      onKeyDown={onKeyDown}
      style={placement}
    >
      {path.length > 0 && (
        <button
          type="button"
          role="menuitem"
          className="row-overflow-back"
          onClick={() => setPath((current) => current.slice(0, -1))}
        >
          <ChevronLeft size={14} aria-hidden="true" />
          <span>{path.length === 1 ? label : t('Back')}</span>
        </button>
      )}
      {menuItems.map((item, index) => renderRowOverflowItem({ item, index, hasCheckItems, setPath, setOpen }))}
    </div>,
    document.body
  );
}

export function RowOverflowMenu({
  label,
  items,
  tooltip,
}: {
  label: string;
  items: RowOverflowMenuItem[];
  /** The trigger's tooltip; "Actions" by default. */
  tooltip?: string;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<number[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const anchorBounds = useRef<ReturnType<typeof captureRowMenuAnchor> | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  // A retained Dock tab keeps this row mounted while inert. The panel lives on
  // document.body, where inert cannot reach it, so the owning surface's active
  // signal unmounts the portal in the SAME commit as the deactivation.
  const surfaceActive = useSurfaceActive();
  const menuOpen = open && surfaceActive;
  useEffect(() => {
    if (!surfaceActive && open) setOpen(false);
  }, [open, surfaceActive]);
  // ABB (user: 백버튼 대응): the open menu owns hardware back, so the phone's
  // back gesture closes it instead of leaving the PWA.
  useMobileBack(menuOpen, () => setOpen(false));
  const menuItems = path.reduce<RowOverflowMenuItem[]>((current, index) => current[index]?.children ?? current, items);
  const hasCheckItems = menuItems.some((item) => item.checked !== undefined);

  useRowOverflowDismiss({ menuOpen, path, panel, trigger, setOpen });
  useEffect(() => {
    if (!menuOpen) {
      anchorBounds.current = null;
      if (path.length) setPath([]);
    }
  }, [menuOpen, path.length]);

  // Measure on the input event, before React starts the open render. Reading
  // geometry while rendering the portal forced Chromium to synchronously lay
  // out the whole workbench and made a tiny options menu feel conspicuously
  // late on dense panels.
  const placement = positionRowMenu(
    menuOpen ? anchorBounds.current : null,
    menuItems.length + (path.length ? 1 : 0),
    menuItems.filter((item) => item.separatorBefore).length,
    window.innerWidth,
    window.innerHeight
  );
  useRowMenuClamp(menuOpen, panel);
  const rememberAnchor = (element: HTMLButtonElement) => {
    anchorBounds.current = captureRowMenuAnchor(element);
  };
  const toggleMenu = (element: HTMLButtonElement) => {
    if (!open && !anchorBounds.current) rememberAnchor(element);
    commitImmediateOverlay(() => setOpen((value) => !value));
  };
  // A host element (see rowOverflowHostProps) asks this menu to open, at the
  // pointer when coordinates are given, otherwise at the trigger.
  useEffect(() => {
    const element = trigger.current;
    if (!element) return undefined;
    const openAt: RowOverflowOpener = (point) => {
      const anchor = captureRowMenuAnchor(element);
      if (point) {
        const { x, y } = point;
        anchor.bounds = { x, y, left: x, right: x, top: y, bottom: y, width: 0, height: 0, toJSON: () => ({}) };
        anchor.atPointer = true;
      }
      anchorBounds.current = anchor;
      commitImmediateOverlay(() => setOpen(true));
    };
    rowOverflowOpeners.set(element, openAt);
    return () => {
      rowOverflowOpeners.delete(element);
    };
  }, []);

  return (
    <div className="row-overflow">
      <button
        ref={trigger}
        type="button"
        className="row-overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tooltip={tooltip ?? t('Actions')}
        onPointerEnter={(event) => rememberAnchor(event.currentTarget)}
        onFocus={(event) => rememberAnchor(event.currentTarget)}
        // Pointer users see the menu on PRESS instead of waiting for release.
        // Keyboard and assistive clicks have detail=0 and keep the click path.
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          clickGuard.markPointerActivation();
          toggleMenu(event.currentTarget);
        }}
        onClick={(event) => {
          if (clickGuard.consumePointerClick()) return;
          if (event.detail !== 0) return;
          toggleMenu(event.currentTarget);
        }}
        onPointerCancel={clickGuard.clearPointerActivation}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {menuOpen &&
        renderRowOverflowPanel({
          panel,
          label,
          path,
          menuItems,
          hasCheckItems,
          placement,
          onKeyDown: (event) => rowOverflowMenuKeyDown(event, { panel, path, setPath }),
          setPath,
          setOpen,
        })}
    </div>
  );
}

import { Check, ChevronRight, MoreHorizontal } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { t } from './i18n';
import { closeOnUserScroll, useMenuDismiss } from './menu-dismiss';
import { useMobileBack } from './mobile-back';
import { useSurfaceActive } from './surface-activity';
import { captureRowMenuAnchor, positionRowMenu, useRowMenuClamp } from './row-menu-geometry';
import { ENABLED_MENU_ITEM_SELECTOR, isContextMenuKey, pointerMenuPoint } from './ScmContextMenu';
import { type Submenu, SubmenuPanel, useSubmenu } from './submenu';

type RowOverflowMenuEntry = {
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
};

type RowOverflowMenuItem = RowOverflowMenuEntry & {
  /** A submenu that opens beside the item. */
  children?: RowOverflowMenuEntry[];
};

const menuItemRole = (item: RowOverflowMenuEntry) => {
  if (item.checked === undefined) return 'menuitem';
  return item.radio ? 'menuitemradio' : 'menuitemcheckbox';
};

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
 *  to the trigger, or first steps out of an open submenu), on Tab
 *  (menu-dismiss.ts) and on anything that moves it: resize or a user scroll
 *  (closeOnUserScroll). Its submenu counts as inside. */
function useRowOverflowDismiss({
  menuOpen,
  panel,
  subPanel,
  trigger,
  submenu,
  setOpen,
}: {
  menuOpen: boolean;
  panel: RefObject<HTMLDivElement | null>;
  subPanel: RefObject<HTMLDivElement | null>;
  trigger: RefObject<HTMLButtonElement | null>;
  submenu: Submenu<string>;
  setOpen(open: boolean): void;
}): void {
  useMenuDismiss({
    open: menuOpen,
    close: () => setOpen(false),
    trigger,
    panels: () => [panel.current, subPanel.current],
    onEscape: (event) => {
      if (!submenu.escape()) return false;
      event.stopPropagation();
      return true;
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: panel and subPanel are refs and setOpen a useState setter (all stable); listeners attach per open.
  useEffect(() => {
    if (!menuOpen) return undefined;
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR)?.focus());
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    const stopScrollDismiss = closeOnUserScroll(close, (target) =>
      Boolean(panel.current?.contains(target) || subPanel.current?.contains(target))
    );
    return () => {
      window.removeEventListener('resize', close);
      stopScrollDismiss();
    };
  }, [menuOpen]);
}

/** Roving focus over the items of the panel (menu or submenu) the key was pressed in. */
function rowOverflowMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(ENABLED_MENU_ITEM_SELECTOR)];
  if (!entries.length) return;
  const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
  let next = -1;
  if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = entries.length - 1;
  else return;
  event.preventDefault();
  entries[next]?.focus();
}

const hasCheckItems = (items: RowOverflowMenuEntry[]) => items.some((item) => item.checked !== undefined);

function renderRowOverflowItem({
  item,
  checkGutter,
  submenu,
  setOpen,
}: {
  item: RowOverflowMenuItem;
  checkGutter: boolean;
  /** The menu level's submenus; absent inside a submenu. */
  submenu?: Submenu<string>;
  setOpen(open: boolean): void;
}) {
  const opener = item.children?.length && submenu ? submenu.trigger(item.id, item.disabled) : null;
  const select = () => {
    item.onSelect?.();
    if (item.closeOnSelect !== false) setOpen(false);
  };
  // Action labels can change in place (Delete → Confirm delete). Keep the
  // positional action node stable so focus, hover, and flex layout do not
  // reset while the open menu confirms a destructive action.
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked is only set when role is menuitemcheckbox; the role is dynamic.
    <button
      key={item.id}
      type="button"
      data-action-id={item.id}
      role={menuItemRole(item)}
      aria-checked={item.checked === undefined ? undefined : item.checked}
      className={
        [item.danger ? 'danger' : '', item.separatorBefore ? 'menu-separator' : ''].filter(Boolean).join(' ') ||
        undefined
      }
      disabled={item.disabled}
      title={item.title}
      {...(opener ?? submenu?.item())}
      onClick={opener ? opener.onClick : select}
    >
      {checkGutter && (
        <span className="row-overflow-check">{item.checked && <Check size={14} aria-hidden="true" />}</span>
      )}
      <span className="row-overflow-label">{item.label}</span>
      {opener && <ChevronRight className="row-overflow-submenu" size={14} aria-hidden="true" />}
    </button>
  );
}

function renderRowOverflowPanel({
  panel,
  subPanel,
  label,
  items,
  placement,
  submenu,
  submenuId,
  setOpen,
}: {
  panel: RefObject<HTMLDivElement | null>;
  subPanel: RefObject<HTMLDivElement | null>;
  label: string;
  items: RowOverflowMenuItem[];
  placement: ReturnType<typeof positionRowMenu>;
  submenu: Submenu<string>;
  submenuId: string | null;
  setOpen(open: boolean): void;
}) {
  const parent = items.find((item) => item.id === submenuId);
  const children = parent?.children;
  return createPortal(
    <div
      ref={panel}
      className="row-overflow-menu"
      role="menu"
      aria-label={t('{{label}} menu', { label })}
      onKeyDown={rowOverflowMenuKeyDown}
      style={placement}
    >
      {items.map((item) => renderRowOverflowItem({ item, checkGutter: hasCheckItems(items), submenu, setOpen }))}
      {parent && children?.length ? (
        <SubmenuPanel
          anchor={submenu.element(parent.id)}
          panelRef={subPanel}
          className="row-overflow-menu"
          label={t('{{label}} menu', { label: parent.label })}
          onKeyDown={rowOverflowMenuKeyDown}
        >
          {children.map((item) => renderRowOverflowItem({ item, checkGutter: hasCheckItems(children), setOpen }))}
        </SubmenuPanel>
      ) : null}
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
  const [submenuId, setSubmenuId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const subPanel = useRef<HTMLDivElement>(null);
  const anchorBounds = useRef<ReturnType<typeof captureRowMenuAnchor> | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  // The panel portals to document.body, beyond the reach of the surface's `inert`: unmount it with the surface.
  const surfaceActive = useSurfaceActive();
  const menuOpen = open && surfaceActive;
  useEffect(() => {
    if (!surfaceActive && open) setOpen(false);
  }, [open, surfaceActive]);
  // ABB: the open menu owns hardware back, so the phone's
  // back gesture closes it instead of leaving the PWA.
  useMobileBack(menuOpen, () => setOpen(false));
  const submenu = useSubmenu<string>({
    menuOpen,
    openKey: submenuId,
    open: setSubmenuId,
    close: () => setSubmenuId(null),
    panel: () => subPanel.current,
  });

  useRowOverflowDismiss({ menuOpen, panel, subPanel, trigger, submenu, setOpen });
  useEffect(() => {
    if (!menuOpen) {
      anchorBounds.current = null;
      if (submenuId !== null) setSubmenuId(null);
    }
  }, [menuOpen, submenuId]);

  // Measure on the input event, before React starts the open render. Reading
  // geometry while rendering the portal forced Chromium to synchronously lay
  // out the whole workbench and made a tiny options menu feel conspicuously
  // late on dense panels. The viewport is read only for an open menu: reading
  // window.innerWidth also lays the page out, and every closed ⋯ of a list
  // did that on each render (a rail page's first commit paid a full layout).
  const placement = () =>
    positionRowMenu(
      anchorBounds.current,
      items.length,
      items.filter((item) => item.separatorBefore).length,
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
          subPanel,
          label,
          items,
          placement: placement(),
          submenu,
          submenuId,
          setOpen,
        })}
    </div>
  );
}

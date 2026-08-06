import { Check, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { t } from './i18n';
import { useSurfaceActive } from './surface-activity';

export type RowOverflowMenuItem = {
  /** Stable semantic action identity; labels may change while the menu stays open. */
  id: string;
  label: string;
  onSelect?(): void;
  disabled?: boolean;
  danger?: boolean;
  closeOnSelect?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
  children?: RowOverflowMenuItem[];
};

export function RowOverflowMenu({
  label,
  items,
  width = 132,
}: {
  label: string;
  items: RowOverflowMenuItem[];
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<number[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const anchorBounds = useRef<DOMRect | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  // A retained Dock tab keeps this row mounted while inert. The panel lives on
  // document.body, where inert cannot reach it, so the owning surface's active
  // signal unmounts the portal in the SAME commit as the deactivation.
  const surfaceActive = useSurfaceActive();
  const menuOpen = open && surfaceActive;
  useEffect(() => {
    if (!surfaceActive && open) setOpen(false);
  }, [open, surfaceActive]);
  const menuItems = path.reduce<RowOverflowMenuItem[]>((current, index) =>
    current[index]?.children ?? current, items);

  useEffect(() => {
    if (!menuOpen) return undefined;
    queueMicrotask(() => panel.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus());
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menuOpen, path]);
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
  const bounds = menuOpen ? anchorBounds.current : null;
  const itemHeight = window.matchMedia?.('(pointer: coarse)').matches ? 44 : 36;
  const height = itemHeight * (menuItems.length + (path.length ? 1 : 0)) + 8;
  const left = Math.max(8, Math.min(
    (bounds?.right || width + 8) - width,
    window.innerWidth - width - 8,
  ));
  const below = (bounds?.bottom || 8) + 4;
  const top = below + height <= window.innerHeight - 8
    ? below
    : Math.max(8, (bounds?.top || height + 12) - height - 4);
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(panel.current
      ?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") || [])];
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
    }
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else if (event.key === 'Tab') {
      setOpen(false);
      return;
    } else return;
    event.preventDefault();
    entries[next]?.focus();
  };
  const rememberAnchor = (element: HTMLButtonElement) => {
    anchorBounds.current = element.getBoundingClientRect();
  };
  const toggleMenu = (element: HTMLButtonElement) => {
    if (!open && !anchorBounds.current) rememberAnchor(element);
    commitImmediateOverlay(() => setOpen((value) => !value));
  };

  return <div className="row-overflow">
    <button ref={trigger} type="button" className="row-overflow-trigger"
      aria-label={t(label)} aria-haspopup="menu" aria-expanded={menuOpen}
      data-tooltip={t("Actions")}
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
      onPointerCancel={clickGuard.clearPointerActivation}>
      <MoreHorizontal size={18} aria-hidden="true" />
    </button>
    {menuOpen && createPortal(<div ref={panel} className="row-overflow-menu" role="menu"
      aria-label={t("{{label}} menu", { label: t(label) })} onKeyDown={onMenuKeyDown}
      style={{ left, top, width }}>
      {path.length > 0 && <button type="button" role="menuitem" className="row-overflow-back"
        onClick={() => setPath((current) => current.slice(0, -1))}>
        <ChevronLeft size={14} aria-hidden="true" />
        <span>{path.length === 1 ? t(label) : t("Back")}</span>
      </button>}
      {menuItems.map((item, index) => {
        const submenu = Boolean(item.children?.length);
        // Action labels can change in place (Delete → Confirm delete). Keep the
        // positional action node stable so focus, hover, and flex layout do not
        // reset while the open menu confirms a destructive action.
        return <button key={item.id} type="button"
          data-action-id={item.id}
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={item.checked === undefined ? undefined : item.checked}
          aria-haspopup={submenu ? "menu" : undefined}
          data-submenu={submenu ? "true" : undefined}
          className={[
            item.danger ? 'danger' : '',
            item.separatorBefore ? 'menu-separator' : '',
          ].filter(Boolean).join(' ') || undefined}
          disabled={item.disabled}
          onClick={() => {
            if (submenu) {
              setPath((current) => [...current, index]);
              return;
            }
            item.onSelect?.();
            if (item.closeOnSelect !== false) setOpen(false);
          }}>
          <span className="row-overflow-check">
            {item.checked && <Check size={14} aria-hidden="true" />}
          </span>
          <span className="row-overflow-label">{t(item.label)}</span>
          {submenu && <ChevronRight className="row-overflow-submenu" size={14} aria-hidden="true" />}
        </button>;
      })}
    </div>, document.body)}
  </div>;
}

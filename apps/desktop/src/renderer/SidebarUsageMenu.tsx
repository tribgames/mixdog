import { Check, MoreHorizontal } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { commitImmediateOverlay, useImmediateOverlayClickGuard } from './immediate-overlay';
import { t } from './i18n';
import { closeOnUserScroll, useMenuDismiss } from './menu-dismiss';
import { useMobileBack } from './mobile-back';
import { captureRowMenuAnchor, positionRowMenu, useRowMenuClamp } from './row-menu-geometry';
import type { UsageRailBars, UsageRailSlots } from './SidebarUsage';

const ENABLED_ITEM = "[role='menuitemcheckbox']:not(:disabled), [role='menuitemradio']:not(:disabled)";

/** The usage flyout's `···` menu: rail pin switch plus the rail bar mode.
 *  Same open/dismiss/roving-focus conventions as RowOverflowMenu; the panel is
 *  portaled because the flyout clips its own overflow. */
export function SidebarUsageMenu({
  pinned,
  onTogglePin,
  railBars,
  onRailBarsChange,
  accountsExpanded = false,
  onAccountsExpandedChange,
  railSlots = '5',
  onRailSlotsChange,
}: {
  pinned: boolean;
  onTogglePin(): void;
  railBars: UsageRailBars;
  onRailBarsChange?(next: UsageRailBars): void;
  accountsExpanded?: boolean;
  onAccountsExpandedChange?(next: boolean): void;
  railSlots?: UsageRailSlots;
  onRailSlotsChange?(next: UsageRailSlots): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const anchorBounds = useRef<ReturnType<typeof captureRowMenuAnchor> | null>(null);
  const clickGuard = useImmediateOverlayClickGuard();
  useMobileBack(open, () => setOpen(false));

  useMenuDismiss({ open, close: () => setOpen(false), trigger, panels: () => [panel.current] });
  useEffect(() => {
    if (!open) {
      anchorBounds.current = null;
      return undefined;
    }
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(ENABLED_ITEM)?.focus());
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    const stopScrollDismiss = closeOnUserScroll(close, (target) => Boolean(panel.current?.contains(target)));
    return () => {
      window.removeEventListener('resize', close);
      stopScrollDismiss();
    };
  }, [open]);

  const rememberAnchor = (element: HTMLButtonElement) => {
    anchorBounds.current = captureRowMenuAnchor(element);
  };
  const toggleMenu = (element: HTMLButtonElement) => {
    if (!open && !anchorBounds.current) rememberAnchor(element);
    commitImmediateOverlay(() => setOpen((value) => !value));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(panel.current?.querySelectorAll<HTMLButtonElement>(ENABLED_ITEM) ?? [])];
    if (!entries.length) return;
    const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
    let next: number;
    if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else return;
    event.preventDefault();
    entries[next]?.focus();
  };

  const radio = (value: UsageRailBars, label: string, hint: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={railBars === value}
      disabled={!pinned}
      data-rail-bars={value}
      data-tooltip={hint}
      onClick={() => onRailBarsChange?.(value)}
    >
      <span className="row-overflow-check" aria-hidden="true">
        {railBars === value && <Check size={14} />}
      </span>
      <span className="row-overflow-label">{label}</span>
    </button>
  );

  const slotsRadio = (value: UsageRailSlots, label: string) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={railSlots === value}
      disabled={!pinned}
      data-rail-slots={value}
      onClick={() => onRailSlotsChange?.(value)}
    >
      <span className="row-overflow-check" aria-hidden="true">
        {railSlots === value && <Check size={14} />}
      </span>
      <span className="row-overflow-label">{label}</span>
    </button>
  );

  const placement = positionRowMenu(open ? anchorBounds.current : null, 8, 1, window.innerWidth, window.innerHeight);
  useRowMenuClamp(open, panel);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="session-panel-action sidebar-usage-menu"
        aria-label={t('Usage menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={t('Usage menu')}
        onPointerEnter={(event) => rememberAnchor(event.currentTarget)}
        onFocus={(event) => rememberAnchor(event.currentTarget)}
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
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="row-overflow-menu usage-menu"
            data-usage-menu-overlay
            role="menu"
            aria-label={t('Usage menu')}
            onKeyDown={onKeyDown}
            style={placement}
          >
            <button type="button" role="menuitemcheckbox" aria-checked={pinned} onClick={onTogglePin}>
              <span className="row-overflow-check" aria-hidden="true">
                {pinned && <Check size={14} />}
              </span>
              <span className="row-overflow-label">{t('Pin to rail')}</span>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={accountsExpanded}
              data-usage-accounts-expand
              onClick={() => onAccountsExpandedChange?.(!accountsExpanded)}
            >
              <span className="row-overflow-check" aria-hidden="true">
                {accountsExpanded && <Check size={14} />}
              </span>
              <span className="row-overflow-label">{t('Expand all accounts')}</span>
            </button>
            {/* biome-ignore lint/a11y/useSemanticElements: <hr> default border/margin would change the styling. */}
            <div className="usage-menu-separator" role="separator" />
            <div className="usage-menu-group" role="presentation">
              {t('Rail bars')}
            </div>
            {radio('long', t('Longest period only'), t('Only the longest period, such as monthly or weekly'))}
            {radio(
              'short-long',
              t('5-hour + longest period'),
              t('5-hour and weekly as two bars; the number shows the higher')
            )}
            {/* biome-ignore lint/a11y/useSemanticElements: <hr> default border/margin would change the styling. */}
            <div className="usage-menu-separator" role="separator" />
            <div className="usage-menu-group" role="presentation">
              {t('Rail slots')}
            </div>
            {slotsRadio('3', t('{{n}} slots', { n: 3 }))}
            {slotsRadio('5', t('{{n}} slots', { n: 5 }))}
            {slotsRadio('all', t('All slots'))}
          </div>,
          document.body
        )}
    </>
  );
}

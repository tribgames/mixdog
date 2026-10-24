import { ArrowLeftRight, ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProviderAccountsList } from './ProviderAccountsList';
import { viewportRect } from './anchored-panel';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import type { UsageApi } from './usage-dashboard-store';

export function ProviderAccountPicker({
  api,
  provider,
  label,
}: {
  api?: UsageApi;
  provider: string;
  /** Text trigger ("Account 1 · 3 accounts ▾") in place of the swap icon. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useMobileBack(open, () => setOpen(false));
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      // On a phone the fixed popup's containing block is the body, which sits
      // at the visual viewport's origin: place in body-local coordinates.
      const phone = document.documentElement.hasAttribute('data-mixdog-mobile-tabs');
      const view = viewportRect();
      const frame = phone
        ? document.body.getBoundingClientRect()
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const width = phone ? frame.width : Math.min(frame.width, view.width);
      const height = phone ? frame.height : Math.min(frame.height, view.height);
      setPosition({
        left: Math.max(8, Math.min(rect.right - frame.left + 6, width - (260 + 8))),
        top: Math.max(8, Math.min(rect.top - frame.top, height - (menu.current?.offsetHeight || 180) - 8)),
      });
    };
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node))
        setOpen(false);
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper only catches Escape bubbling from the trigger/menu inside; it is not itself interactive.
    <span
      className="provider-account-picker-wrap"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={label ? 'provider-account-picker-trigger has-label' : 'provider-account-picker-trigger'}
        aria-label={t('Select account for {{provider}}', { provider })}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label ? (
          <>
            <span>{label}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </>
        ) : (
          <ArrowLeftRight size={14} aria-hidden="true" />
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="provider-account-picker"
            style={position}
            data-provider-account-overlay
            role="dialog"
            aria-label={t('Accounts and priority')}
          >
            <ProviderAccountsList api={api} provider={provider} listOnly />
          </div>,
          document.body
        )}
    </span>
  );
}

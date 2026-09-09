import { MoreHorizontal } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProviderAccountsList } from './ProviderAccountsList';
import { t } from './i18n';
import type { UsageApi } from './usage-dashboard-store';

export function ProviderAccountPicker({ api, provider }: { api?: UsageApi; provider: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        left: Math.max(8, Math.min(rect.right + 6, window.innerWidth - 288)),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - (menu.current?.offsetHeight || 180) - 8)),
      });
    };
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  return <span onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="provider-account-picker-trigger"
      aria-label={t('Select account for {{provider}}', { provider })} aria-expanded={open}
      onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} aria-hidden="true" /></button>
    {open && createPortal(<div ref={menu} className="provider-account-picker" style={position}
      data-provider-account-overlay role="dialog" aria-label={t('Accounts and priority')}>
      <ProviderAccountsList api={api} provider={provider} listOnly />
    </div>, document.body)}
  </span>;
}

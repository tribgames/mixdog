import { t } from '../i18n';

/** Full-bleed tap target that dismisses a phone-width overlay panel. */
function Backdrop({
  className,
  open,
  label,
  onClose,
}: {
  className: string;
  open: boolean;
  label: string;
  onClose(): void;
}) {
  return (
    <button
      type="button"
      className={className}
      data-state={open ? 'open' : 'closed'}
      aria-hidden={!open}
      tabIndex={open ? 0 : -1}
      onClick={onClose}
      aria-label={label}
    />
  );
}

export function SidebarBackdrop({ open, onClose }: { open: boolean; onClose(): void }) {
  return <Backdrop className="sidebar-backdrop" open={open} label={t('Close session sidebar')} onClose={onClose} />;
}

export function PanelBackdrop({ open, onClose }: { open: boolean; onClose(): void }) {
  return <Backdrop className="panel-backdrop" open={open} label={t('Close panel')} onClose={onClose} />;
}

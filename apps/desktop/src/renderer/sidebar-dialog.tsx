import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { acquireTitleBarDim } from './titlebar-dim';

/** Shared lifecycle for dialogs launched from a sidebar destination.
 *  Content keeps its own card and form grammar; this layer owns the portal,
 *  backdrop dismissal, Escape, mobile back, and native title-bar dimming. */
export function SidebarDialogLayer({ onClose, children }: {
  onClose(): void;
  children: ReactNode;
}) {
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return createPortal(<div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    {children}
  </div>, document.body);
}

/** Immediate acknowledgement while a clicked row fetches its editor payload. */
export function SidebarLoadingDialog({ title, onClose, dataAttributes }: {
  title: string;
  onClose(): void;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const titleId = useId();
  return <SidebarDialogLayer onClose={onClose}>
    <section className="schedules-dialog sidebar-loading-dialog" role="dialog" aria-modal="true"
      aria-labelledby={titleId} {...dataAttributes}>
      <header>
        <h2 id={titleId}>{title}</h2>
        <div className="schedules-dialog-header-actions">
          <button type="button" aria-label={t('Close')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="sidebar-dialog-loading" role="status">
        <LoaderCircle size={16} aria-hidden="true" />
        <span>{t('Loading…')}</span>
      </div>
    </section>
  </SidebarDialogLayer>;
}

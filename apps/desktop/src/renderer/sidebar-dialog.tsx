import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { acquireTitleBarDim } from './titlebar-dim';

/** The portaled scrim both dialog layers share: a backdrop press or Escape
 *  closes it. */
function dialogLayerPortal(className: string, host: HTMLElement, onClose: () => void, children: ReactNode) {
  return createPortal(
    <div
      className={className}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </div>,
    host
  );
}

/** Shared lifecycle for dialogs launched from a sidebar destination.
 *  Content keeps its own card and form grammar; this layer owns the portal,
 *  backdrop dismissal, Escape, mobile back, and native title-bar dimming. */
export function SidebarDialogLayer({ onClose, children }: { onClose(): void; children: ReactNode }) {
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  return dialogLayerPortal('schedules-dialog-layer', document.body, onClose, children);
}

/** A dialog scoped to the PANE that raised it (user: 골 설정 뜨는 게 PANE
 *  중앙에 뜨는 게 낫지 않을까). The card portals into the anchor's `.pane-cell`
 *  and centers there; the scrim covers only that pane, so sibling panes stay
 *  visible and usable, and the title bar is not dimmed. Falls back to the
 *  window-level layer when the anchor is not inside a pane. */
export function PaneDialogLayer({
  anchor,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  children: ReactNode;
}) {
  const [pane] = useState<HTMLElement | null>(() => anchor.current?.closest<HTMLElement>('.pane-cell') ?? null);
  useMobileBack(true, onClose);
  useEffect(() => (pane ? undefined : acquireTitleBarDim()), [pane]);
  return dialogLayerPortal(
    pane ? 'pane-dialog-layer' : 'schedules-dialog-layer',
    pane ?? document.body,
    onClose,
    children
  );
}

/** Immediate acknowledgement while a clicked row fetches its editor payload. */
export function SidebarLoadingDialog({
  title,
  onClose,
  dataAttributes,
}: {
  title: string;
  onClose(): void;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const titleId = useId();
  return (
    <SidebarDialogLayer onClose={onClose}>
      <section
        className="schedules-dialog sidebar-loading-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...dataAttributes}
      >
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
    </SidebarDialogLayer>
  );
}

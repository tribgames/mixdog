import { LoaderCircle, X } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { acquireTitleBarDim } from './titlebar-dim';

/** The portaled scrim both dialog layers share: a backdrop press or Escape
 *  closes it. */
function dialogLayerPortal(className: string, host: HTMLElement, onClose: () => void, children: ReactNode) {
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim container; backdrop press and Escape dismissal are delegated here for the dialog inside
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

/** Keeps Tab / Shift+Tab cycling inside a modal card (its keydown handler). */
export function containDialogTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)'
    ),
  ];
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
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

/** Editor footer: the error line, an armed two-step delete when the entry is
 *  deletable, the caller's extra actions, then Cancel / Save. */
export function EditorDialogFooter({
  error,
  busy,
  onCancel,
  onDelete,
  children,
  saveDisabled = false,
}: {
  error: string;
  busy: boolean;
  onCancel(): void;
  onDelete?(): void;
  children?: ReactNode;
  /** The form is incomplete (e.g. an agent switched on with no model). */
  saveDisabled?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <footer>
      {error && <ErrorNotice error={error} />}
      {onDelete && (
        <button
          type="button"
          className={`danger${confirmDelete ? ' confirming' : ''}`}
          disabled={busy}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            onDelete();
          }}
        >
          {confirmDelete ? t('Confirm delete') : t('Delete')}
        </button>
      )}
      {children}
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
        {t('Cancel')}
      </button>
      <button type="submit" disabled={busy || saveDisabled}>
        {t('Save')}
      </button>
    </footer>
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

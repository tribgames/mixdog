import { RefreshCw } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { emptyStateHost } from './empty-state-host';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { DockHeaderRow, type DockAction } from './pane-dock-chrome';

/** Every state renders inside the same flex-column frame, so an empty, loading
 *  or failed pane centres its message on both axes exactly like the other
 *  dock panes. */
export function SessionDiffFrame({
  children,
  onKeyDown,
}: {
  children: ReactNode;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
}) {
  return (
    <section className="session-diff-pane" aria-label={t('Session diff')} onKeyDown={onKeyDown}>
      {children}
    </section>
  );
}

export function SessionDiffHeader({
  tabStrip,
  source,
  scope,
  actions,
  onClose,
  refreshDisabled,
  onRefresh,
}: {
  tabStrip?: ReactNode;
  source: ReactNode;
  scope: ReactNode;
  actions: DockAction[];
  onClose?(): void;
  refreshDisabled: boolean;
  onRefresh(): void;
}) {
  const refreshButton = (
    <button
      type="button"
      className="browser-pane-nav-button session-diff-refresh"
      aria-label={t('Refresh')}
      data-tooltip={t('Refresh')}
      disabled={refreshDisabled}
      onClick={onRefresh}
    >
      <RefreshCw size={15} aria-hidden="true" />
    </button>
  );
  if (!tabStrip) {
    return (
      <DockHeaderRow
        className="session-diff-header session-diff-toolbar"
        ariaLabel={t('Changes')}
        onClose={onClose}
        left={
          <>
            {source}
            {scope}
          </>
        }
        controlsLead={refreshButton}
        actions={actions}
      />
    );
  }
  return (
    <>
      <DockHeaderRow
        className="session-diff-header"
        ariaLabel={t('Changes')}
        onClose={onClose}
        left={tabStrip}
        actions={actions}
      />
      <div className="browser-pane-toolbar session-diff-toolbar">
        {source}
        {scope}
        {refreshButton}
      </div>
    </>
  );
}

/** A pane without a diff to list shows only its state under the header;
 *  null once there is a diff to list. */
export function sessionDiffStatus(
  sessionId: string,
  { loading, ready, unsupported, error }: { loading: boolean; ready: boolean; unsupported: boolean; error: string },
  onRetry: () => void
): ReactNode {
  if (!sessionId)
    return (
      <p className="utility-dock-empty mx-empty-state" ref={emptyStateHost}>
        {t('Open a session to view its diff.')}
      </p>
    );
  if (loading && !ready) return <InitialSurface />;
  if (error) return <ErrorNotice error={error} onRetry={onRetry} />;
  if (unsupported)
    return (
      <p className="utility-dock-empty mx-empty-state" ref={emptyStateHost}>
        {t('Session diff is unavailable.')}
      </p>
    );
  return null;
}

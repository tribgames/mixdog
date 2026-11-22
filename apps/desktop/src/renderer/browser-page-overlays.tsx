import { BrowserLoadingPlaceholder } from './BrowserLoadingPlaceholder';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { emptyStateHost } from './empty-state-host';

/** What covers the page: the themed placeholder until a real page paints,
 *  the empty-address prompt, or a load failure with Retry. */
export function BrowserPageOverlays({
  painted,
  pageFailure,
  currentUrl,
  initialUrl,
  onRetry,
}: {
  painted: boolean;
  pageFailure: { title: string; detail: string } | null;
  currentUrl: string;
  initialUrl?: string;
  onRetry(): void;
}) {
  return (
    <>
      {/* about:blank paints Chromium's default white; until a real page is
        committed the pane stays in the app theme instead. */}
      {!painted && !pageFailure && <BrowserLoadingPlaceholder url={currentUrl || initialUrl || ''} />}
      {painted && !currentUrl && (
        <div className="browser-pane-empty mx-empty-state mx-empty-state-cover" ref={emptyStateHost} aria-hidden="true">
          <span>{t('Search or enter address')}</span>
        </div>
      )}
      {pageFailure && (
        <div className="browser-pane-failure">
          <ErrorNotice error={pageFailure.detail} title={pageFailure.title} role="status" onRetry={onRetry} />
        </div>
      )}
    </>
  );
}

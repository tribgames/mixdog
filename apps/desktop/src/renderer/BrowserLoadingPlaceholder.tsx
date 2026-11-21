import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';

/** Host of an address, or '' when it has none (or is not an address). */
function browserHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function BrowserLoadingPlaceholder({ url }: { url: string }) {
  const host = browserHostLabel(url);
  return (
    <div className="browser-pane-loading" role="status" aria-label={t('Loading browser…')}>
      <ProgressSpinner size={24} aria-hidden="true" />
      {host && <span className="browser-pane-loading-host">{host}</span>}
    </div>
  );
}

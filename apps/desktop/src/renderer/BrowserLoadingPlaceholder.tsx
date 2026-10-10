// What a browser surface shows until its page has painted: the app's own
// sheet with a spinner and the host being opened, instead of the black
// rectangle of a native view that has nothing to draw yet. It sits over the
// page surface, so the native view stays hidden (the shell is drawing over it)
// until this placeholder is removed.
import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';

/** Host of an address, or '' when it has none (or is not an address). */
export function browserHostLabel(url: string): string {
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

import { errorMessageText } from './ErrorNotice';
import { showDesktopToast } from './desktop-toasts';
import { t } from './i18n';

/** Electron rejects loadURL with ERR_ABORTED (-3) when the user, or a newer
 *  navigation, supersedes the load. That is not a failure. */
export function isAbortedLoad(error: unknown): boolean {
  const { code, errno, message } = (error ?? {}) as { code?: unknown; errno?: unknown; message?: unknown };
  return code === 'ERR_ABORTED' || errno === -3 || /\bERR_ABORTED\b|\(-3\)/.test(String(message ?? ''));
}

/** Toast a load failure other than a user abort. */
export function reportBrowserLoadFailure(error: unknown): void {
  if (isAbortedLoad(error)) return;
  showDesktopToast(t('Unable to load page: {{error}}', { error: errorMessageText(error) }), 'error');
}

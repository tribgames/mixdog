// "로그인 유지 중인 사이트": the sites the Browser Use profile stays signed in
// to (one login is enough; routines reuse it), each with 로그아웃, plus 전체
// 지우기 — which also deletes what was imported from Chrome — and the Chrome
// importer beside the list. Built on the import dialog's frame and styles.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cookie, Download, Globe, X } from 'lucide-react';

import type { DesktopBrowserSignedInSite } from '../shared/contract';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { scrimDismiss } from './scrim-dismiss';
import { ProgressSpinner } from './ProgressSpinner';
import { watchBrowserDialogFocus } from './browser-dialog-focus';
import { useMobileBack } from './mobile-back';
import { CompactSwitch } from './settings/capability-controls';

const AUTO_SIGN_IN = 'browserAutoSignIn';

export function BrowserSignInsDialog({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  /** Opens the existing Chrome import dialog; absent where it is unavailable. */
  onImport?: () => void;
}) {
  const desktopApi = window.mixdogDesktop;
  const dialogRef = useRef<HTMLElement | null>(null);
  const [sites, setSites] = useState<DesktopBrowserSignedInSite[] | null>(null);
  const [busy, setBusy] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  /** "저장된 로그인으로 자동 로그인" (the `browserAutoSignIn` setting); null: unavailable. */
  const [autoSignIn, setAutoSignIn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useMobileBack(open, requestClose);
  useEffect(() => {
    if (!open) return undefined;
    return watchBrowserDialogFocus(dialogRef, requestClose, 'button:not(:disabled)');
  }, [open, requestClose]);

  const reload = useCallback(async () => {
    const api = window.mixdogDesktop;
    if (!api?.browserSignedInSites) return;
    try {
      setSites(await api.browserSignedInSites());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    setSites(null);
    setError('');
    setConfirmAll(false);
    void reload();
    // The setting lives on this PC; a client without it shows no switch.
    void Promise.resolve(window.mixdogDesktop?.readSettings?.())
      .then((settings) => setAutoSignIn(settings ? settings.browserAutoSignIn !== false : null))
      .catch(() => setAutoSignIn(null));
  }, [open, reload]);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await work();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  if (!open) return null;
  return (
    // Backdrop click-to-dismiss is a pointer convenience; keyboard dismissal is handled by the dialog focus watcher.
    <div className="browser-import-backdrop" {...scrimDismiss(requestClose)}>
      <section
        ref={dialogRef}
        className="browser-import-dialog browser-sign-ins-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-sign-ins-title"
        aria-describedby="browser-sign-ins-description"
      >
        <header>
          <div>
            <h2 id="browser-sign-ins-title">{t('Signed-in sites')}</h2>
            <p id="browser-sign-ins-description">{t('Sign in once here; tasks and routines use the same sign-ins.')}</p>
          </div>
          <button type="button" className="browser-pane-nav-button" onClick={requestClose} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </header>
        <div className="browser-import-items browser-sign-ins-list">
          {sites === null && !error ? <ProgressSpinner size={16} /> : null}
          {sites?.length === 0 ? <p className="browser-sign-ins-empty">{t('No signed-in sites')}</p> : null}
          {sites?.map((entry) => (
            <div key={entry.site} className="browser-import-item browser-sign-ins-site">
              <span className="browser-import-item-icon">
                <Globe size={18} />
              </span>
              <span className="browser-import-item-label">
                <strong>{entry.site}</strong>
                <small>
                  <Cookie size={11} aria-hidden="true" /> {t('{{count}} cookies', { count: entry.cookies })}
                </small>
              </span>
              <button
                type="button"
                className="browser-import-secondary"
                disabled={Boolean(busy)}
                onClick={() => void run(entry.site, async () => desktopApi?.browserSignOutSite?.(entry.site))}
              >
                {busy === entry.site ? <ProgressSpinner size={14} /> : null}
                {t('Sign out')}
              </button>
            </div>
          ))}
        </div>
        {autoSignIn !== null && (
          <div className="browser-sign-ins-auto">
            <span className="browser-import-item-label">
              <strong>{t('Sign in automatically with saved logins')}</strong>
              <small>
                {t(
                  'The agent signs in by itself on sites with a saved password. You are told when two-step verification is needed.'
                )}
              </small>
            </span>
            <CompactSwitch
              label={t('Sign in automatically with saved logins')}
              checked={autoSignIn}
              onChange={(next) => {
                setAutoSignIn(next);
                void desktopApi
                  ?.updateSetting(AUTO_SIGN_IN, next)
                  .then((settings) => setAutoSignIn(settings.browserAutoSignIn !== false))
                  .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
              }}
            />
          </div>
        )}
        {confirmAll && (
          <p className="browser-import-auth-notice" role="note">
            {t('Every site is signed out and the passwords, cookies and history imported from Chrome are deleted.')}
          </p>
        )}
        {error && <ErrorNotice error={error} />}
        <footer>
          {confirmAll ? (
            // Clearing is destructive: it asks once more, with a way back.
            <button
              type="button"
              className="browser-import-secondary"
              disabled={Boolean(busy)}
              onClick={() => setConfirmAll(false)}
            >
              {t('Cancel')}
            </button>
          ) : (
            onImport && (
              <button type="button" className="browser-import-secondary" disabled={Boolean(busy)} onClick={onImport}>
                <Download size={14} aria-hidden="true" />
                {t('Import from Chrome')}
              </button>
            )
          )}
          <button
            type="button"
            className="browser-import-secondary browser-import-danger"
            disabled={Boolean(busy) || !desktopApi?.browserClearSignIns}
            onClick={() => {
              if (!confirmAll) {
                setConfirmAll(true);
                return;
              }
              void run('all', async () => desktopApi?.browserClearSignIns?.()).then(() => setConfirmAll(false));
            }}
          >
            {busy === 'all' ? <ProgressSpinner size={16} /> : null}
            {confirmAll ? t('Clear everything') : t('Clear all')}
          </button>
        </footer>
      </section>
    </div>
  );
}

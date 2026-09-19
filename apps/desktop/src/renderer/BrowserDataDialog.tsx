import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Cookie, Database, HardDrive, LoaderCircle, X } from 'lucide-react';

import type { DesktopBrowserDataClearResult, DesktopBrowserDataScope } from '../shared/contract';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';

interface BrowserDataDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Cache first and selected: it is the one scope a person can always reclaim
 * without losing anything they would notice. */
const DEFAULT_SCOPES: Record<DesktopBrowserDataScope, boolean> = {
  cache: true,
  siteData: false,
  cookies: false,
};

export function BrowserDataDialog({ open, onClose }: BrowserDataDialogProps) {
  const desktopApi = window.mixdogDesktop;
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const [scopes, setScopes] = useState<Record<DesktopBrowserDataScope, boolean>>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DesktopBrowserDataClearResult | null>(null);
  const [error, setError] = useState('');

  busyRef.current = busy;

  const requestClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    setScopes(DEFAULT_SCOPES);
    setResult(null);
    setError('');
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
      ].filter((element) => element.offsetParent !== null || element === document.activeElement);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    };
  }, [open, requestClose]);

  const selected = (Object.keys(scopes) as DesktopBrowserDataScope[]).filter((scope) => scopes[scope]);

  const clear = useCallback(() => {
    if (!desktopApi?.browserClearData || busyRef.current || !selected.length) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    void desktopApi
      .browserClearData(selected)
      .then((next) => {
        setResult(next);
        const failed = Object.values(next.errors).filter(Boolean);
        // A partial sweep must read as partial, never as "everything is gone".
        if (failed.length) setError(failed.join(' '));
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  }, [desktopApi, selected]);

  const scopeRow = (scope: DesktopBrowserDataScope, label: string, detail: string, icon: React.ReactNode) => {
    const cleared = result?.cleared.includes(scope) === true;
    const failure = result?.errors[scope];
    return (
      <label className="browser-import-item" key={scope}>
        <span className="browser-import-item-icon">{icon}</span>
        <span className="browser-import-item-label">
          <strong>{label}</strong>
          <small>{failure || detail}</small>
        </span>
        {(cleared || failure) && (
          <span
            className={`browser-import-state is-${cleared ? 'completed' : 'failed'}`}
            aria-label={cleared ? t('Completed') : t('Failed')}
          >
            {cleared ? <Check size={16} /> : <AlertTriangle size={16} />}
          </span>
        )}
        {!cleared && !failure && (
          <input
            type="checkbox"
            checked={scopes[scope]}
            disabled={busy}
            onChange={(event) => setScopes((current) => ({ ...current, [scope]: event.target.checked }))}
          />
        )}
      </label>
    );
  };

  if (!open) return null;

  let description = t('Select what to remove from the built-in browser');
  if (busy) description = t('Clearing browsing data…');
  else if (result) description = error ? t('Some data could not be cleared') : t('Browsing data cleared');
  return (
    <div
      className="browser-import-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="browser-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-data-title"
        aria-describedby="browser-data-description"
      >
        <header>
          <div>
            <h2 id="browser-data-title">{t('Clear browsing data')}</h2>
            <p id="browser-data-description">{description}</p>
          </div>
          {!busy && (
            <button type="button" className="browser-pane-nav-button" onClick={requestClose} aria-label={t('Close')}>
              <X size={16} />
            </button>
          )}
        </header>
        {scopeRow(
          'cache',
          t('Cache'),
          t('Pages reload more slowly once, nothing else changes.'),
          <HardDrive size={16} />
        )}
        {scopeRow(
          'siteData',
          t('Site data'),
          t('Local files and databases sites saved on this device.'),
          <Database size={16} />
        )}
        {scopeRow('cookies', t('Cookies'), t('Signs you out of every site in this browser.'), <Cookie size={16} />)}
        {error ? <ErrorNotice error={error} /> : null}
        <footer>
          {!busy && (
            <button type="button" className="browser-import-secondary" onClick={requestClose}>
              {result ? t('Close') : t('Cancel')}
            </button>
          )}
          {!result && (
            <button
              type="button"
              className="browser-import-primary"
              disabled={busy || !selected.length}
              onClick={clear}
            >
              {busy ? <LoaderCircle size={16} className="is-spinning" /> : null}
              {t('Clear now')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

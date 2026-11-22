import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Cookie, History, KeyRound, X } from 'lucide-react';
import { ProgressSpinner } from './ProgressSpinner';

import type {
  DesktopBrowserImportItem,
  DesktopBrowserImportProgress,
  DesktopBrowserImportSource,
} from '../shared/contract';
import { t, uiFormatLocale } from './i18n';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { watchBrowserDialogFocus } from './browser-dialog-focus';
import { useMobileBack } from './mobile-back';
import { scrimDismiss } from './scrim-dismiss';

interface BrowserImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** `settings`: raised over the Settings dialog, as its other nested dialogs are;
   *  `pane` (default): fills the browser pane below its toolbar. */
  layer?: 'pane' | 'settings';
}

function itemLabel(item: DesktopBrowserImportItem): string {
  if (item === 'passwords') return t('Saved passwords');
  return item === 'cookies' ? t('Cookies') : t('Browsing history');
}

function itemFailure(items: readonly DesktopBrowserImportItem[], error: string): string {
  const item = new Intl.ListFormat(uiFormatLocale(), { type: 'conjunction' }).format(items.map(itemLabel));
  return t('{{item}} could not be imported: {{error}}', { item, error });
}

const EMPTY_ITEMS: Record<DesktopBrowserImportItem, boolean> = {
  passwords: false,
  cookies: false,
  history: false,
};

function progressStateLabel(state: string): string {
  if (state === 'completed') return t('Completed');
  return state === 'failed' ? t('Failed') : t('In progress');
}

function ProgressStateIcon({ state }: { state: string }) {
  if (state === 'completed') return <Check size={16} />;
  if (state === 'failed') return <AlertTriangle size={16} />;
  return <ProgressSpinner size={16} />;
}

function checkedItems(items: Record<DesktopBrowserImportItem, boolean>): DesktopBrowserImportItem[] {
  return (Object.keys(items) as DesktopBrowserImportItem[]).filter((item) => items[item]);
}

/** Passwords and cookies the source can actually export need administrator approval. */
function includesSensitiveItem(
  items: readonly DesktopBrowserImportItem[],
  source: DesktopBrowserImportSource | undefined
): boolean {
  return items.some((item) => (item === 'passwords' || item === 'cookies') && source?.supports[item] === true);
}

function supportedItems(source: DesktopBrowserImportSource | undefined): Record<DesktopBrowserImportItem, boolean> {
  return {
    passwords: source?.supports.passwords === true,
    cookies: source?.supports.cookies === true,
    history: source?.supports.history === true,
  };
}

function ImportItemRow({
  item,
  label,
  icon,
  source,
  checked,
  progress,
  busy,
  finished,
  loading,
  onToggle,
}: {
  item: DesktopBrowserImportItem;
  label: string;
  icon: React.ReactNode;
  source: DesktopBrowserImportSource | undefined;
  checked: boolean;
  progress: Partial<Record<DesktopBrowserImportItem, DesktopBrowserImportProgress>>;
  busy: boolean;
  finished: boolean;
  loading: boolean;
  onToggle(checked: boolean): void;
}) {
  const supported = source?.supports[item] !== false;
  const itemProgress = progress[item];
  const selected = supported && checked;
  const showProgress = (busy || finished) && selected;
  const progressState = itemProgress?.state || (busy ? 'running' : 'failed');
  const passwordReason = item === 'passwords' ? source?.passwordSupportReason : '';
  const unsupportedReason = supported ? '' : source?.supportReasons?.[item] || passwordReason || '';
  const importedCount = itemProgress?.count
    ? ` · ${t('{{total}} imported', { total: itemProgress.count.toLocaleString(uiFormatLocale()) })}`
    : '';
  let control: React.ReactNode = (
    <input
      type="checkbox"
      checked={supported && checked}
      disabled={!supported || loading}
      onChange={(event) => onToggle(event.target.checked)}
    />
  );
  if (showProgress) {
    control = (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the state icon span needs an accessible name for the import progress
      <span className={`browser-import-state is-${progressState}`} aria-label={progressStateLabel(progressState)}>
        <ProgressStateIcon state={progressState} />
      </span>
    );
  } else if (busy || finished) {
    control = <span className="browser-import-skipped">{t('Excluded')}</span>;
  }
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox control is rendered through the `control` variable inside this label
    <label className={`browser-import-item${supported ? '' : ' is-disabled'}`}>
      <span className="browser-import-item-icon">{icon}</span>
      <span className="browser-import-item-label">
        <strong>{label}</strong>
        {unsupportedReason ? <small>{unsupportedReason}</small> : null}
        {showProgress && progressState === 'completed' ? (
          <small>
            {t('{{total}} imported', { total: itemProgress?.count?.toLocaleString(uiFormatLocale()) || '0' })}
          </small>
        ) : null}
        {showProgress && progressState === 'failed' ? (
          <small>
            {t('Failed to import')}
            {importedCount}
            {itemProgress?.error ? `: ${itemProgress.error}` : ''}
          </small>
        ) : null}
      </span>
      {control}
    </label>
  );
}

export function BrowserImportDialog({ open, onClose, layer = 'pane' }: BrowserImportDialogProps) {
  const desktopApi = window.mixdogDesktop;
  const dialogRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const activeJobRef = useRef('');
  /** Kinds the running job reported done, read when the whole call is refused. */
  const completedRef = useRef(new Set<DesktopBrowserImportItem>());
  const [sources, setSources] = useState<DesktopBrowserImportSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [items, setItems] = useState<Record<DesktopBrowserImportItem, boolean>>(EMPTY_ITEMS);
  const [administratorApproved, setAdministratorApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const setError = (text: string) => setErrors(text ? [text] : []);
  const [progress, setProgress] = useState<Partial<Record<DesktopBrowserImportItem, DesktopBrowserImportProgress>>>({});

  busyRef.current = busy;

  const requestClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  useMobileBack(open, requestClose);

  useEffect(() => {
    if (!open) return undefined;
    return watchBrowserDialogFocus(
      dialogRef,
      requestClose,
      'button:not(:disabled), select:not(:disabled), input:not(:disabled)'
    );
  }, [open, requestClose]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: desktopApi is the constant window bridge read once per render; listing it is harmless and only matters if the bridge object is replaced
  useEffect(() => {
    if (!open || !desktopApi?.browserProfileImportSources) return undefined;
    let live = true;
    setLoading(true);
    setFinished(false);
    setError('');
    setProgress({});
    setAdministratorApproved(false);
    void desktopApi
      .browserProfileImportSources()
      .then((nextSources) => {
        if (!live) return;
        setSources(nextSources);
        const source = nextSources[0];
        const profile = source?.profiles[0];
        setSourceId(source?.id || '');
        setProfileId(profile?.id || '');
        setItems(supportedItems(source));
        if (!source || !profile) setError(t('Could not find any importable Chrome profiles.'));
      })
      .catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [desktopApi, open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: desktopApi is the constant window bridge read once per render; listing it is harmless and only matters if the bridge object is replaced
  useEffect(() => {
    if (!desktopApi?.onBrowserProfileImportProgress) return undefined;
    return desktopApi.onBrowserProfileImportProgress((update) => {
      if (update.jobId !== activeJobRef.current) return;
      if (update.state === 'completed') completedRef.current.add(update.item);
      setProgress((current) => ({
        ...current,
        [update.item]: update,
      }));
    });
  }, [desktopApi]);

  const selectedSource = sources.find((source) => source.id === sourceId);
  const selectedItems = checkedItems(items);
  const sensitiveSelected = includesSensitiveItem(selectedItems, selectedSource);

  // biome-ignore lint/correctness/useExhaustiveDependencies: desktopApi is the constant window bridge read once per render; listing it is harmless and only matters if the bridge object is replaced
  const startImport = useCallback(() => {
    if (!desktopApi?.browserProfileImportStart || busyRef.current) return;
    const requestedItems = checkedItems(items);
    if (!requestedItems.length) {
      setError(t('Select at least one item to import.'));
      return;
    }
    if (includesSensitiveItem(requestedItems, selectedSource) && !administratorApproved) {
      setError(t('Acknowledge administrator approval to import passwords and cookies.'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFinished(false);
    setError('');
    setProgress({});
    const jobId = crypto.randomUUID().replaceAll('-', '');
    completedRef.current = new Set();
    activeJobRef.current = jobId;
    void desktopApi
      .browserProfileImportStart({
        jobId,
        sourceId,
        profileId,
        items: requestedItems,
        administratorApproved,
      })
      .then((result) => {
        setFinished(true);
        setProgress(
          Object.fromEntries(
            requestedItems.map((item) => [
              item,
              {
                jobId: result.jobId,
                item,
                state: result.errors[item] ? 'failed' : 'completed',
                count: result.counts[item],
                error: result.errors[item],
              },
            ])
          )
        );
        // One notice per failed kind: a notice headlines only its first line.
        setErrors(
          requestedItems.flatMap((item) => {
            const failure = result.errors[item];
            return failure ? [itemFailure([item], failure)] : [];
          })
        );
      })
      .catch((reason) => {
        // The whole run was refused: what already reported done stays done, the rest failed with this reason.
        const message = errorMessageText(reason);
        const failed = requestedItems.filter((item) => !completedRef.current.has(item));
        setFinished(true);
        setProgress((current) =>
          Object.fromEntries(
            requestedItems.map((item) => [
              item,
              failed.includes(item)
                ? { jobId, item, state: 'failed', count: current[item]?.count, error: message }
                : current[item],
            ])
          )
        );
        setErrors([failed.length ? itemFailure(failed, message) : message]);
      })
      .finally(() => {
        activeJobRef.current = '';
        busyRef.current = false;
        setBusy(false);
      });
  }, [administratorApproved, desktopApi, items, profileId, selectedSource, sourceId]);

  if (!open) return null;

  const importItems: { item: DesktopBrowserImportItem; label: string; icon: React.ReactNode }[] = [
    { item: 'passwords', label: itemLabel('passwords'), icon: <KeyRound size={18} /> },
    { item: 'cookies', label: itemLabel('cookies'), icon: <Cookie size={18} /> },
    { item: 'history', label: itemLabel('history'), icon: <History size={18} /> },
  ];

  let description = t('Select data to import into the built-in browser');
  if (busy) description = t('Importing browser data…');
  else if (finished) description = errors.length ? t('Some data could not be imported') : t('Browser data imported');

  return (
    // Backdrop click-to-dismiss is a pointer convenience; keyboard dismissal is handled by the dialog focus watcher.
    <div
      className={layer === 'settings' ? 'settings-confirm-layer' : 'browser-import-backdrop'}
      {...scrimDismiss(requestClose)}
    >
      <section
        ref={dialogRef}
        className="browser-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-import-title"
        aria-describedby="browser-import-description"
        data-settings-nested-dialog
      >
        <header>
          <div>
            <h2 id="browser-import-title">{t('Import from browser')}</h2>
            <p id="browser-import-description">{description}</p>
          </div>
          {!busy && (
            <button
              type="button"
              className="browser-pane-nav-button"
              onClick={requestClose}
              aria-label={t('Close')}
              data-settings-nested-close
            >
              <X size={16} />
            </button>
          )}
        </header>
        {!busy && !finished && (
          <div className="browser-import-source">
            <span>{t('Source')}</span>
            <select
              value={`${sourceId}\u0000${profileId}`}
              aria-label={t('Chrome profile to import')}
              disabled={loading}
              onChange={(event) => {
                const [nextSourceId, nextProfileId] = event.target.value.split('\u0000');
                const source = sources.find((candidate) => candidate.id === nextSourceId);
                setSourceId(nextSourceId);
                setProfileId(nextProfileId);
                setItems(supportedItems(source));
                setAdministratorApproved(false);
              }}
            >
              {sources.flatMap((source) =>
                source.profiles.map((profile) => (
                  <option key={`${source.id}:${profile.id}`} value={`${source.id}\u0000${profile.id}`}>
                    {source.name} · {profile.name}
                    {profile.accountEmail ? ` (${profile.accountEmail})` : ''}
                  </option>
                ))
              )}
            </select>
          </div>
        )}
        <div className="browser-import-items">
          {importItems.map(({ item, label, icon }) => (
            <ImportItemRow
              key={item}
              item={item}
              label={label}
              icon={icon}
              source={selectedSource}
              checked={items[item]}
              progress={progress}
              busy={busy}
              finished={finished}
              loading={loading}
              onToggle={(checked) => setItems((current) => ({ ...current, [item]: checked }))}
            />
          ))}
        </div>
        {items.cookies && (
          <p className="browser-import-auth-notice" role="note">
            {t('Cookie import does not verify sign-in. Some sites require signing in again in a supported browser.')}
          </p>
        )}
        {!busy && !finished && sensitiveSelected && (
          <label className="browser-import-admin">
            <strong>{t('Administrator approval required')}</strong>
            <span className="browser-import-admin-check">
              <input
                type="checkbox"
                checked={administratorApproved}
                onChange={(event) => setAdministratorApproved(event.target.checked)}
              />
              {t('I understand the app requests administrator approval to import Chrome data')}
            </span>
          </label>
        )}
        {errors.map((text) => (
          <ErrorNotice key={text} error={text} />
        ))}
        <footer>
          <button type="button" className="browser-import-secondary" disabled={busy} onClick={requestClose}>
            {finished ? t('Close') : t('Cancel')}
          </button>
          {(!finished || errors.length > 0) && (
            <button
              type="button"
              className="browser-import-primary"
              disabled={
                busy || loading || !profileId || !selectedItems.length || (sensitiveSelected && !administratorApproved)
              }
              onClick={startImport}
            >
              {busy ? <ProgressSpinner size={16} /> : null}
              {finished ? t('Retry') : t('Import')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';

import type { DesktopApi, DesktopBrowserImportProfile, DesktopCookieAutoImportStatus } from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t, uiFormatLocale } from '../i18n';
import { ActionButton, Group, SelectRow, ToggleRow } from './capability-controls';
import { watchSettingsRead } from './read-recovery';

type CookieAutoImportApi = Partial<
  Pick<
    DesktopApi,
    | 'browserCookieAutoImportStatus'
    | 'browserCookieAutoImportConfigure'
    | 'browserCookieAutoImportForgetKey'
    | 'browserProfileImportSources'
    | 'sections'
  >
>;

/** The one-line state of the last run; empty until there is one to report. */
function cookieAutoImportSummary(status: DesktopCookieAutoImportStatus): string {
  if (status.running) return t('In progress');
  // A skip is reported only while it is the latest attempt, so it outranks an earlier recorded failure.
  if (!status.needsManualImport && !status.skippedChromeRunning && status.lastError) {
    return t('Last import failed: {{error}}', { error: status.lastError });
  }
  let state = '';
  if (status.needsManualImport) {
    state = t('Needs one manual import: use Import to approve once and save the Chrome key.');
  } else if (status.skippedChromeRunning) {
    state = t('Last import skipped: Chrome was running. Close Chrome to import cookies.');
  }
  const last =
    status.lastImportAt === undefined
      ? ''
      : t('Last imported {{time}} · {{total}} cookies', {
          time: new Date(status.lastImportAt).toLocaleString(uiFormatLocale()),
          total: (status.lastCount ?? 0).toLocaleString(uiFormatLocale()),
        });
  return [state, last].filter(Boolean).join(' ');
}

export function CookieAutoImportGroup({
  api,
  active,
  revision,
}: {
  api: CookieAutoImportApi;
  active: boolean;
  /** Changes when a manual import finished, which may have saved the key. */
  revision: number;
}) {
  const [status, setStatus] = useState<DesktopCookieAutoImportStatus | null>(null);
  const [profiles, setProfiles] = useState<DesktopBrowserImportProfile[]>([]);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const refreshStatus = useRef<(() => void) | null>(null);
  const refreshProfiles = useRef<(() => void) | null>(null);

  useEffect(() => {
    const read = api.browserCookieAutoImportStatus;
    if (!active || !read) return undefined;
    let live = true;
    const watch = watchSettingsRead(
      api,
      async (signal) => {
        if (writing.current) return;
        const stamp = version.current;
        const next = await read();
        if (live && !signal.aborted && stamp === version.current && !writing.current) setStatus(next);
      },
      5_000
    );
    refreshStatus.current = watch.replace;
    return () => {
      live = false;
      refreshStatus.current = null;
      watch.stop();
    };
  }, [active, api]);

  useEffect(() => {
    const sources = api.browserProfileImportSources;
    if (!active || !sources || !api.browserCookieAutoImportStatus) return undefined;
    let live = true;
    const watch = watchSettingsRead(
      api,
      async (signal) => {
        const next = await sources();
        if (live && !signal.aborted) setProfiles(next.find((source) => source.supports.cookies)?.profiles ?? []);
      },
      30_000
    );
    refreshProfiles.current = watch.replace;
    return () => {
      live = false;
      refreshProfiles.current = null;
      watch.stop();
    };
  }, [active, api]);

  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    refreshStatus.current?.();
    refreshProfiles.current?.();
  }, [revision]);

  if (!status || (!status.profileId && profiles.length === 0) || !api.browserCookieAutoImportConfigure) return null;
  const summary = status.enabled || status.lastImportAt !== undefined ? cookieAutoImportSummary(status) : '';

  const run = (work: () => Promise<DesktopCookieAutoImportStatus> | undefined) => {
    if (writing.current) return;
    writing.current = true;
    version.current += 1;
    setBusy(true);
    setError('');
    void Promise.resolve()
      .then(work)
      .then((next) => {
        if (next) setStatus(next);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        writing.current = false;
        setBusy(false);
      });
  };
  // The profile the runs use, even when Chrome no longer lists it (shown as missing, never replaced).
  // Until one is bound, the first listed is what a toggle or choice here binds.
  const bound = status.profileId;
  const missing = bound !== '' && !profiles.some((profile) => profile.id === bound);
  const selected = bound !== '' ? bound : (profiles[0]?.id ?? '');

  return (
    <Group>
      <ToggleRow
        title={t('Import cookies automatically')}
        description={t('Re-imports on app start and Chrome exit, no approval.')}
        showDescription
        disabled={busy}
        checked={status.enabled}
        onChange={(next) => run(() => api.browserCookieAutoImportConfigure?.({ enabled: next, profileId: selected }))}
      />
      <p className="settings-empty">
        {t('Signed-out sites are skipped automatically; import manually.')}
      </p>
      <SelectRow
        title={t('Chrome profile to import')}
        disabled={busy}
        value={selected}
        options={[
          ...(missing ? [{ value: bound, label: t('{{id}} (profile not found)', { id: bound }) }] : []),
          ...profiles.map((profile) => ({
            value: profile.id,
            label: profile.accountEmail ? `${profile.name} (${profile.accountEmail})` : profile.name,
          })),
        ]}
        onChange={(value) => {
          run(() => api.browserCookieAutoImportConfigure?.({ enabled: status.enabled, profileId: value }));
        }}
      />
      {summary && (
        <p className="settings-empty" role="status">
          {summary}
        </p>
      )}
      {status.keySaved && (
        <div className="mixdog-settings__row">
          <div className="mixdog-settings__copy">
            <span className="mixdog-settings__row-desc">{t('Chrome key saved on this PC (encrypted).')}</span>
          </div>
          <div className="settings-row-control">
            <ActionButton disabled={busy} onClick={() => run(() => api.browserCookieAutoImportForgetKey?.())}>
              {t('Forget saved key')}
            </ActionButton>
          </div>
        </div>
      )}
      {!status.keyStorageAvailable && (
        <p className="settings-empty">
          {t('This PC can’t protect a saved key; imports need approval (auto off).')}
        </p>
      )}
      {error && <ErrorNotice error={error} />}
    </Group>
  );
}

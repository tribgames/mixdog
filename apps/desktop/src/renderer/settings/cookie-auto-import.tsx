// 설정 › 인증 관리: re-import Chrome's cookies by itself whenever Chrome is
// closed. It reuses the Chrome key a manual import saved, so it never asks for
// administrator approval; without that key it says one manual import is needed.
import { useEffect, useRef, useState } from 'react';

import type { DesktopApi, DesktopBrowserImportProfile, DesktopCookieAutoImportStatus } from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t, uiFormatLocale } from '../i18n';
import { ActionButton, Group, SelectRow, ToggleRow } from './capability-controls';

type CookieAutoImportApi = Partial<
  Pick<
    DesktopApi,
    | 'browserCookieAutoImportStatus'
    | 'browserCookieAutoImportConfigure'
    | 'browserCookieAutoImportForgetKey'
    | 'browserProfileImportSources'
  >
>;

/** While a run is in progress the status is re-read at this pace. */
const RUNNING_REFRESH_MS = 2_000;

/** The one-line state of the last run. */
export function cookieAutoImportSummary(status: DesktopCookieAutoImportStatus): string {
  if (status.running) return t('In progress');
  if (status.needsManualImport) {
    return t('Needs one manual import: use Import to approve once and save the Chrome key.');
  }
  if (status.lastError) return t('Last import failed: {{error}}', { error: status.lastError });
  if (status.lastImportAt === undefined) return t('Not imported yet.');
  return t('Last imported {{time}} · {{total}} cookies', {
    time: new Date(status.lastImportAt).toLocaleString(uiFormatLocale()),
    total: (status.lastCount ?? 0).toLocaleString(uiFormatLocale()),
  });
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
  const [profileId, setProfileId] = useState('');
  const [error, setError] = useState('');
  const latestRead = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const running = status?.running === true;

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and refresh only re-trigger the read
  useEffect(() => {
    if (!active || !api.browserCookieAutoImportStatus || !api.browserProfileImportSources) return;
    const read = ++latestRead.current;
    void Promise.all([api.browserCookieAutoImportStatus(), api.browserProfileImportSources()])
      .then(([next, sources]) => {
        if (read !== latestRead.current) return;
        const list = sources.find((source) => source.supports.cookies)?.profiles ?? [];
        setStatus(next);
        setProfiles(list);
        setProfileId((current) => current || next.profileId || list[0]?.id || '');
      })
      .catch(() => {
        // Not available here (another platform or surface): the section stays hidden.
        if (read === latestRead.current) setStatus(null);
      });
  }, [active, api, revision, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh re-arms the timer after each status read while a run lasts
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setTimeout(() => setRefresh((count) => count + 1), RUNNING_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [running, refresh]);

  if (!status || profiles.length === 0 || !api.browserCookieAutoImportConfigure) return null;

  const run = (work: Promise<DesktopCookieAutoImportStatus> | undefined) => {
    setError('');
    void Promise.resolve(work)
      .then((next) => {
        if (next) setStatus(next);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const selected = profiles.some((profile) => profile.id === profileId) ? profileId : (profiles[0]?.id ?? '');

  return (
    <Group>
      <ToggleRow
        title={t('Import cookies automatically')}
        description={t(
          'While Chrome is closed, cookies are imported again from the chosen profile: when the app starts, after Chrome exits, and every hour. No administrator approval is asked.'
        )}
        showDescription
        checked={status.enabled}
        onChange={(next) => run(api.browserCookieAutoImportConfigure?.({ enabled: next, profileId: selected }))}
      />
      <SelectRow
        title={t('Chrome profile to import')}
        value={selected}
        options={profiles.map((profile) => ({
          value: profile.id,
          label: profile.accountEmail ? `${profile.name} (${profile.accountEmail})` : profile.name,
        }))}
        onChange={(value) => {
          setProfileId(value);
          run(api.browserCookieAutoImportConfigure?.({ enabled: status.enabled, profileId: value }));
        }}
      />
      {(status.enabled || status.lastImportAt !== undefined) && (
        <p className="settings-empty" role="status">
          {cookieAutoImportSummary(status)}
        </p>
      )}
      {status.keySaved && (
        <div className="mixdog-settings__row">
          <div className="mixdog-settings__copy">
            <span className="mixdog-settings__row-desc">{t('Chrome key saved on this PC (encrypted).')}</span>
          </div>
          <div className="settings-row-control">
            <ActionButton onClick={() => run(api.browserCookieAutoImportForgetKey?.())}>
              {t('Forget saved key')}
            </ActionButton>
          </div>
        </div>
      )}
      {!status.keyStorageAvailable && (
        <p className="settings-empty">
          {t('This PC cannot protect a saved key, so every import asks for approval and automatic import cannot run.')}
        </p>
      )}
      {error && <ErrorNotice error={error} />}
    </Group>
  );
}

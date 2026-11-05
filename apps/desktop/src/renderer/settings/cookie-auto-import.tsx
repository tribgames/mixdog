// 설정 › 인증 관리: re-import Chrome's cookies by itself whenever Chrome is
// closed. It reuses the Chrome key a manual import saved, so it never asks for
// administrator approval. Before the first manual import it stays silent; a
// saved key that stops working makes it say one manual import is needed.
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

/** The one-line state of the last run; empty until there is one to report. */
export function cookieAutoImportSummary(status: DesktopCookieAutoImportStatus): string {
  if (status.running) return t('In progress');
  if (status.needsManualImport) {
    return t('Needs one manual import: use Import to approve once and save the Chrome key.');
  }
  if (status.lastError) return t('Last import failed: {{error}}', { error: status.lastError });
  if (status.lastImportAt === undefined) return '';
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
  const summary = status.enabled || status.lastImportAt !== undefined ? cookieAutoImportSummary(status) : '';

  const run = (work: Promise<DesktopCookieAutoImportStatus> | undefined) => {
    setError('');
    void Promise.resolve(work)
      .then((next) => {
        if (next) setStatus(next);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
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
        description={t(
          'While Chrome is closed, cookies are imported again from the chosen profile: when the app starts and each time Chrome exits. No administrator approval is asked.'
        )}
        showDescription
        checked={status.enabled}
        onChange={(next) => run(api.browserCookieAutoImportConfigure?.({ enabled: next, profileId: selected }))}
      />
      <SelectRow
        title={t('Chrome profile to import')}
        value={selected}
        options={[
          ...(missing ? [{ value: bound, label: t('{{id}} (profile not found)', { id: bound }) }] : []),
          ...profiles.map((profile) => ({
            value: profile.id,
            label: profile.accountEmail ? `${profile.name} (${profile.accountEmail})` : profile.name,
          })),
        ]}
        onChange={(value) => {
          run(api.browserCookieAutoImportConfigure?.({ enabled: status.enabled, profileId: value }));
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

// Settings → General → Sessions: auto-archive of unused sessions and
// auto-delete of archived ones (main/session-auto-retention.ts runs the pass).
import { useEffect, useState } from 'react';

import {
  SESSION_AUTO_ARCHIVE_DAY_CHOICES,
  SESSION_AUTO_DELETE_DAY_CHOICES,
  type DesktopApi,
  type DesktopSettings,
  type SessionRetentionSettingKey,
} from '../../shared/contract';
import { t } from '../i18n';
import { OpenSelect } from '../OpenSelect';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { Group, SelectRow } from './capability-controls';
import type { PanelContext } from './capability-data';
import { getCachedDesktopStatus, readDesktopStatus, storeDesktopStatus } from './desktop-status-cache';

type RetentionApi = Partial<Pick<DesktopApi, 'readSettings' | 'setSessionRetention'>>;

const DAY_LABELS: Readonly<Record<number, string>> = {
  1: '1 day',
  7: '7 days',
  14: '14 days',
  30: '30 days',
  90: '90 days',
};

function dayOptions(choices: readonly number[]) {
  return choices.map((days) => ({ value: String(days), label: t(days === 0 ? 'Never' : DAY_LABELS[days]) }));
}

export function SessionRetentionSettings({ pending }: Pick<PanelContext, 'pending'>) {
  const api = (window as unknown as { mixdogDesktop?: RetentionApi }).mixdogDesktop;
  const [settings, setSettings] = useState<DesktopSettings | null>(
    () => getCachedDesktopStatus(api, 'settings') ?? null
  );
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const read = () =>
      void readDesktopStatus(api, 'settings')
        ?.then((next) => {
          if (live) setSettings(next);
        })
        .catch(() => {});
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api]);
  if (!api?.setSessionRetention || !settings) return null;
  const save = (key: SessionRetentionSettingKey, value: string) => {
    const days = Number(value);
    if (days === settings[key]) return;
    setError('');
    void api
      .setSessionRetention?.(key, days)
      .then((saved) => {
        storeDesktopStatus(api, 'settings', saved);
        setSettings(saved);
      })
      .catch(() => setError(t('The setting could not be saved.')));
  };
  const busy = Boolean(pending);
  const deleteTitle = t('Delete archived sessions after');
  return (
    <>
      <Group title={t('Sessions')}>
        <SelectRow
          title={t('Auto-archive inactive sessions')}
          description={t(
            'Sessions with no conversation for this long move to the archive. You can restore them from the archive at any time.'
          )}
          showDescription
          value={String(settings.sessionAutoArchiveDays)}
          disabled={busy}
          options={dayOptions(SESSION_AUTO_ARCHIVE_DAY_CHOICES)}
          onChange={(next) => save('sessionAutoArchiveDays', next)}
        />
        <div className="mixdog-settings__row">
          <div className="mixdog-settings__copy">
            <span className="mixdog-settings__row-title">{deleteTitle}</span>
            <span className="mixdog-settings__row-desc">
              {t(
                'Counted from the day a session was archived. Sessions already in the archive count from the day this feature was turned on.'
              )}
            </span>
            <span className="mixdog-settings__row-desc session-retention-warning">
              {t('Deleted sessions cannot be restored.')}
            </span>
          </div>
          <div className="settings-row-control">
            <OpenSelect
              className="settings-select"
              ariaLabel={deleteTitle}
              value={String(settings.sessionAutoDeleteDays)}
              disabled={busy}
              options={dayOptions(SESSION_AUTO_DELETE_DAY_CHOICES)}
              onChange={(next) => save('sessionAutoDeleteDays', next)}
            />
          </div>
        </div>
        {error && <p role="alert">{error}</p>}
      </Group>
      <p className="session-retention-note">
        {t(
          'Favorite and bot sessions, sessions that are running or open on screen, scheduled-task targets, and sessions with unread replies are never archived.'
        )}
      </p>
    </>
  );
}

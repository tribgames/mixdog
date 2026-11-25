// Settings → General → Sessions: auto-archive of unused sessions and
// auto-delete of archived ones (the core's session auto-retention cycle runs the pass:
// native/core/crates/mixdog-core-session/src/session/auto_retention.rs).
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
import { getCachedDesktopStatus, readDesktopStatus, writeDesktopStatus } from './desktop-status-cache';
import { desktopBridge } from './desktop-bridge';

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
  const api = desktopBridge<RetentionApi>();
  const [settings, setSettings] = useState<DesktopSettings | null>(
    () => getCachedDesktopStatus(api, 'settings') ?? null
  );
  const [error, setError] = useState('');
  // api is the window bridge read each render, listed so the read follows a replaced bridge.
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
    void writeDesktopStatus(api, 'settings', () => api.setSessionRetention?.(key, days))
      .then((saved) => {
        // The newest value held: an answer overtaken by a newer read is not shown.
        const current = getCachedDesktopStatus(api, 'settings') ?? saved;
        if (current) setSettings(current);
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
          description={t('Moves idle sessions to the archive; restore anytime.')}
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
              {t('Counted from archive date (or when this turned on).')}
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
        {t('Favorites, bots, active, scheduled, and unread sessions aren’t archived.')}
      </p>
    </>
  );
}

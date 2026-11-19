// Settings → Bots: how many times in a row bots may hand work to each other before the
// core refuses the next handoff (`desktop.botHandoffLimit`, one global value).
import { useEffect, useRef, useState } from 'react';

import {
  BOT_HANDOFF_LIMIT_MAX,
  BOT_HANDOFF_LIMIT_MIN,
  type DesktopApi,
  type DesktopSettings,
} from '../../shared/contract';
import { isBotHandoffLimit } from '../../shared/desktop-settings';
import { t } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { getCachedDesktopStatus, readDesktopStatus, writeDesktopStatus } from './desktop-status-cache';

type LimitApi = Partial<Pick<DesktopApi, 'readSettings' | 'setBotHandoffLimit'>>;

export function BotHandoffLimitRow({ disabled }: { disabled?: boolean }) {
  const api = (window as unknown as { mixdogDesktop?: LimitApi }).mixdogDesktop;
  const [settings, setSettings] = useState<DesktopSettings | null>(
    () => getCachedDesktopStatus(api, 'settings') ?? null
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const requested = useRef<number | null>(null);
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
  if (!api?.setBotHandoffLimit || !settings) return null;
  const commit = () => {
    if (draft === null) return;
    const limit = Number(draft);
    // An invalid entry stays in the field beside its message until it is edited.
    if (!isBotHandoffLimit(limit)) {
      setError(t('The setting could not be saved.'));
      return;
    }
    setError('');
    // Compared with the last value sent, not only the confirmed one: a save still in flight is what the next edit differs from.
    if (limit === (requested.current ?? settings.botHandoffLimit)) {
      if (requested.current === null) setDraft(null);
      return;
    }
    const previous = requested.current;
    requested.current = limit;
    void writeDesktopStatus(api, 'settings', () => api.setBotHandoffLimit?.(limit))
      .then((saved) => {
        const current = getCachedDesktopStatus(api, 'settings') ?? saved;
        if (current) setSettings(current);
        // The field keeps showing the last committed value until that save, not an earlier one, has settled.
        if (requested.current === limit) {
          requested.current = null;
          // An entry typed while this save was pending is still to be committed: only the saved value's own draft goes.
          setDraft((typed) => (typed !== null && Number(typed) === limit ? null : typed));
        }
      })
      .catch(() => {
        if (requested.current === limit) requested.current = previous;
        setError(t('The setting could not be saved.'));
      });
  };
  const title = t('Bot handoff limit');
  return (
    <div className="mixdog-settings__row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{title}</span>
        <span className="mixdog-settings__row-desc">
          {t('How many times in a row bots can hand work to each other before they stop and ask you (1-20).')}
        </span>
        {error && <span role="alert">{error}</span>}
      </div>
      <div className="settings-row-control">
        <input
          type="number"
          className="settings-input"
          aria-label={title}
          min={BOT_HANDOFF_LIMIT_MIN}
          max={BOT_HANDOFF_LIMIT_MAX}
          step={1}
          disabled={disabled}
          value={draft ?? String(settings.botHandoffLimit)}
          onChange={(event) => {
            setError('');
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
      </div>
    </div>
  );
}

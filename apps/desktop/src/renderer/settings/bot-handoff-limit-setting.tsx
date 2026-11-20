// Settings → Bots: how many times in a row bots may hand work to each other before the
// core refuses the next handoff (`desktop.botHandoffLimit`, one global value).
import { useEffect, useRef, useState } from 'react';

import {
  BOT_HANDOFF_LIMIT_MAX,
  BOT_HANDOFF_LIMIT_MIN,
  type DesktopApi,
  type DesktopSettings,
} from '../../shared/contract';
import { t } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { SelectRow } from './capability-controls';
import { getCachedDesktopStatus, readDesktopStatus, writeDesktopStatus } from './desktop-status-cache';

type LimitApi = Partial<Pick<DesktopApi, 'readSettings' | 'setBotHandoffLimit'>>;

const LIMITS = Array.from({ length: BOT_HANDOFF_LIMIT_MAX - BOT_HANDOFF_LIMIT_MIN + 1 }, (_, index) => {
  const limit = String(BOT_HANDOFF_LIMIT_MIN + index);
  return { value: limit, label: limit };
});

export function BotHandoffLimitRow({ disabled }: { disabled?: boolean }) {
  const api = (window as unknown as { mixdogDesktop?: LimitApi }).mixdogDesktop;
  const [settings, setSettings] = useState<DesktopSettings | null>(
    () => getCachedDesktopStatus(api, 'settings') ?? null
  );
  // The limit last chosen, until its save has settled: it is what the row shows and what the next choice differs from.
  const [requested, setRequested] = useState<number | null>(null);
  // That choice's save. Two choices of one limit are two saves, so it is told by identity.
  const last = useRef<object | null>(null);
  const [error, setError] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge read each render, listed so the read follows a replaced bridge
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
  const shown = requested ?? settings.botHandoffLimit;
  const save = (value: string) => {
    const limit = Number(value);
    if (limit === shown) return;
    setError('');
    const request = {};
    last.current = request;
    setRequested(limit);
    void writeDesktopStatus(api, 'settings', () => api.setBotHandoffLimit?.(limit))
      .then(
        (saved) => {
          const current = getCachedDesktopStatus(api, 'settings') ?? saved;
          if (current) setSettings(current);
          return true;
        },
        () => false
      )
      .then((saved) => {
        // Only the last choice settles the row: it then shows the confirmed limit, and says so if that is not the choice.
        if (last.current !== request) return;
        last.current = null;
        setRequested(null);
        if (!saved) setError(t('The setting could not be saved.'));
      });
  };
  return (
    <>
      <SelectRow
        title={t('Bot handoff limit')}
        description={t('How many times in a row bots can hand work to each other before they stop and ask you (1-20).')}
        showDescription
        value={String(shown)}
        disabled={disabled}
        options={LIMITS}
        onChange={save}
      />
      {error && <p role="alert">{error}</p>}
    </>
  );
}

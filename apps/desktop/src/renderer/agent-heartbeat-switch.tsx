// The representative bot's profile: the same "Regular check-ins" switch as
// Settings → Bots (getHeartbeatSettings / setHeartbeatEnabled), since the
// check-ins are what the representative bot does on its own.
import { useEffect, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { record } from './record-utils';
import { CompactSwitch } from './settings/capability-controls';

export type HeartbeatSwitchApi = Partial<Pick<DesktopApi, 'invokeCapability'>>;

export function HeartbeatSwitch({ api, active }: { api: HeartbeatSwitchApi | undefined; active: boolean }) {
  // On until read, as on the Bots page.
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active || !api?.invokeCapability) return;
    let live = true;
    api
      .invokeCapability({ capability: 'getHeartbeatSettings', args: [] })
      .then((result) => {
        if (live) setEnabled(record(record(result).value).heartbeat !== false);
      })
      .catch((reason: unknown) => {
        if (live) setError(errorMessageText(reason));
      });
    return () => {
      live = false;
    };
  }, [api, active]);
  const change = async (next: boolean) => {
    setBusy(true);
    setError('');
    try {
      await api?.invokeCapability?.({ capability: 'setHeartbeatEnabled', args: [next] });
      setEnabled(next);
    } catch (reason) {
      setError(errorMessageText(reason));
    } finally {
      setBusy(false);
    }
  };
  const title = t('Regular check-ins');
  return (
    <section className="agent-create-section agent-profile-heartbeat">
      <div className="connector-switch-row" data-heartbeat-switch="true">
        <span className="connector-switch-name">
          <b>{title}</b>
          <small>
            {t(
              'Every 30 minutes, checks your bots and sessions and lets you know only when something needs attention.'
            )}
          </small>
        </span>
        <CompactSwitch label={title} checked={enabled} disabled={busy} onChange={(next) => void change(next)} />
      </div>
      {error && <ErrorNotice error={error} />}
    </section>
  );
}

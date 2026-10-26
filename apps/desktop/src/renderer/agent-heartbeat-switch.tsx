// The representative bot's profile: the same "Regular check-ins" switch as
// Settings → Bots (getHeartbeatSettings / setHeartbeatEnabled), since the
// check-ins are what the representative bot does on its own.
import { useEffect, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { record } from './record-utils';
import { subscribeSetupChanges } from './setup-change-refresh';
import { subscribeHeartbeatSetting } from './settings/capability-data';
import { CompactSwitch } from './settings/capability-controls';

export type HeartbeatSwitchApi = Partial<Pick<DesktopApi, 'invokeCapability'>>;

export function HeartbeatSwitch({ api, active }: { api: HeartbeatSwitchApi | undefined; active: boolean }) {
  // On until read, as on the Bots page.
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  // Read sequence: only the newest read may land, and a local write supersedes pending ones.
  const reads = useRef(0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active || !api?.invokeCapability) return;
    let live = true;
    const read = () => {
      const mine = ++reads.current;
      api
        .invokeCapability?.({ capability: 'getHeartbeatSettings', args: [] })
        .then((result) => {
          if (live && mine === reads.current) setEnabled(record(record(result).value).heartbeat !== false);
        })
        .catch((reason: unknown) => {
          if (live && mine === reads.current) setError(errorMessageText(reason));
        });
    };
    read();
    // Settings → Bots flips the same setting while this pane stays open; a
    // change made elsewhere arrives as the setup-change broadcast.
    const stops = [subscribeHeartbeatSetting(read), subscribeSetupChanges(read)];
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [api, active]);
  const change = async (next: boolean) => {
    setBusy(true);
    setError('');
    reads.current += 1;
    try {
      await api?.invokeCapability?.({ capability: 'setHeartbeatEnabled', args: [next] });
      reads.current += 1;
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
              'Regularly checks your bots and sessions and lets you know only when something needs attention.'
            )}
          </small>
        </span>
        <CompactSwitch label={title} checked={enabled} disabled={busy} onChange={(next) => void change(next)} />
      </div>
      {error && <ErrorNotice error={error} />}
    </section>
  );
}

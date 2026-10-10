import { useCallback, useEffect, useState } from 'react';

import type { DesktopRemoteHost } from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t, uiFormatLocale } from '../i18n';
import { ActionButton, Group, ResourceRow } from './capability-controls';
import type { CapabilityApi } from './capability-data';

const HOSTS_REFRESH_MS = 3_000;

/** "Connect to another PC": paste the pairing link from the other computer's
 *  Settings → Connection, then manage the computers saved here. Each opens its
 *  own window; this app stays fully usable beside it. */
export function RemoteHostsPanel({ api }: { api: CapabilityApi }) {
  const [hosts, setHosts] = useState<DesktopRemoteHost[]>([]);
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmForget, setConfirmForget] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void api
      .listRemoteHosts?.()
      .then((next) => setHosts(next ?? []))
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (!api.listRemoteHosts) return undefined;
    refresh();
    const timer = window.setInterval(refresh, HOSTS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [api, refresh]);

  if (!api.connectRemoteHost) return null;

  const run = (key: string, action: () => Promise<unknown> | undefined): void => {
    setBusy(key);
    setError('');
    void Promise.resolve()
      .then(action)
      .then(refresh)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(''));
  };
  const connect = (): void => {
    const target = link.trim();
    if (!target || !api.connectRemoteHost) return;
    run('connect', async () => {
      await api.connectRemoteHost?.(target, name.trim() || undefined);
      setLink('');
      setName('');
    });
  };

  return (
    <Group
      title={t('Connect to another PC')}
      description={t(
        'Paste the pairing link from Settings → Connection on the other computer. It opens in its own window and asks that computer for approval.'
      )}
    >
      <form
        className="settings-remote-host-form"
        onSubmit={(event) => {
          event.preventDefault();
          connect();
        }}
      >
        <input
          type="url"
          name="link"
          value={link}
          placeholder={t('Pairing link')}
          aria-label={t('Pairing link')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setLink(event.currentTarget.value)}
        />
        <input
          type="text"
          name="name"
          value={name}
          maxLength={80}
          placeholder={t('Name (optional)')}
          aria-label={t('Name (optional)')}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <ActionButton disabled={!link.trim() || busy === 'connect'} onClick={connect}>
          {busy === 'connect' ? t('Connecting…') : t('Connect')}
        </ActionButton>
      </form>
      {error && <ErrorNotice error={error} />}
      {hosts.length > 0 && (
        <div className="settings-resource-list">
          {hosts.map((host) => (
            <ResourceRow
              key={host.id}
              title={host.name}
              meta={
                host.lastConnectedAt
                  ? t('Last connected {{lastSeen}}', {
                      lastSeen: new Date(host.lastConnectedAt).toLocaleString(uiFormatLocale()),
                    })
                  : t('Not connected yet')
              }
              status={host.open ? 'Connected' : 'Not connected'}
              actions={
                <>
                  <ActionButton
                    disabled={Boolean(busy)}
                    onClick={() => run(`open:${host.id}`, () => api.openRemoteHost?.(host.id))}
                  >
                    {host.open ? t('Show window') : t('Reconnect')}
                  </ActionButton>
                  <ActionButton
                    danger
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (confirmForget !== host.id) {
                        setConfirmForget(host.id);
                        return;
                      }
                      setConfirmForget('');
                      run(`forget:${host.id}`, () => api.forgetRemoteHost?.(host.id));
                    }}
                  >
                    {confirmForget === host.id ? t('Confirm forget') : t('Forget')}
                  </ActionButton>
                </>
              }
            />
          ))}
        </div>
      )}
    </Group>
  );
}

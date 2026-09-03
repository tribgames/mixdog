import { useEffect, useState } from 'react';
import type { DesktopRemoteAccessInfo } from '../../shared/contract';
import { t } from '../i18n';
import { ActionButton, Group, ResourceRow } from './capability-controls';
import type { CapabilityApi } from './capability-data';
import {
  connectionInfoReady,
  getCachedConnectionInfo,
  preloadConnectionInfo,
  setCachedConnectionInfo,
} from './connection-info';

const CONNECTION_RETRY_MS = 2_000;
const CONNECTION_STALLED_ATTEMPTS = 5;

export function ConnectionPanel({ api }: { api: CapabilityApi }) {
  const [info, setInfo] = useState<DesktopRemoteAccessInfo | null | undefined>(
    () => getCachedConnectionInfo(api),
  );
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [revokingClient, setRevokingClient] = useState('');
  const [confirmClient, setConfirmClient] = useState('');
  const [stalledAttempts, setStalledAttempts] = useState(0);
  const ready = connectionInfoReady(info);

  useEffect(() => {
    if (!ready || !api.getRemoteAccessInfo) return undefined;
    let live = true;
    const refresh = () => {
      void api.getRemoteAccessInfo?.()
        .then((value) => {
          if (!live || !value) return;
          setCachedConnectionInfo(api, value);
          setInfo(value);
        })
        .catch(() => { /* retain the current card */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [ready, api]);

  useEffect(() => {
    if (ready || !api.getRemoteAccessInfo) return undefined;
    let live = true;
    let timer = 0;
    const attempt = () => {
      const startedAt = Date.now();
      void preloadConnectionInfo(api, CONNECTION_RETRY_MS).then((value) => {
        if (!live) return;
        setInfo(value);
        if (connectionInfoReady(value)) return;
        setStalledAttempts((count) => count + 1);
        timer = window.setTimeout(
          attempt,
          Math.max(0, CONNECTION_RETRY_MS - (Date.now() - startedAt)),
        );
      });
    };
    attempt();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, ready]);

  if (!api.getRemoteAccessInfo) {
    const remoteServer = (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
    return <Group title="Web app">
      <p className="settings-connection-note">
        {remoteServer
          ? t('This web app is paired and connected through {{server}}. Pairing QR codes for other browsers live in the desktop app under Settings → Connection.', { server: remoteServer })
          : t('Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.')}
      </p>
    </Group>;
  }

  if (!ready) {
    if (stalledAttempts >= CONNECTION_STALLED_ATTEMPTS) {
      return <Group title="Web app">
        <p className="settings-connection-note">
          {t('Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.')}
        </p>
      </Group>;
    }
    return <Group title="Web app"
      description="Works on any network. Open the secure link in a browser.">
      <div className="settings-connection-grid">
        <figure className="settings-connection-card settings-connection-card--loading"
          aria-label={t('Preparing pairing code')} aria-busy="true">
          <div className="settings-connection-qr-placeholder" aria-hidden="true" />
          <figcaption>
            <b>{t('Preparing pairing code…')}</b>
            <small>{t('Starting the secure relay')}</small>
          </figcaption>
        </figure>
      </div>
    </Group>;
  }

  return <>
    <Group title="Web app"
      description="Works on any network. Scan to install the app, then approve it here.">
      <div className="settings-connection-grid">
        <figure className="settings-connection-card">
          <div aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: info.relayBrowserQrSvg || '' }} />
          <figcaption>
            <b>{t('Scan to install the web app')}</b>
            <small>{t('Chrome/Edge: Install app · Safari: Add to Home Screen')}</small>
          </figcaption>
        </figure>
      </div>
    </Group>
    {info.clients.length > 0 && <Group title={t('Linked devices')}
      description={t('Review and revoke browsers paired with this desktop.')}>
      <div className="settings-resource-list">
        {info.clients.map((client) => {
          const lastSeen = client.lastSeenAt
            ? new Date(client.lastSeenAt).toLocaleString()
            : t('Never');
          return <ResourceRow key={client.id}
            title={client.name || `${client.platform || 'Device'} · ${client.browser || 'Browser'}`}
            meta={t('Added {{created}} · Last used {{lastSeen}}', {
              created: new Date(client.createdAt).toLocaleDateString(),
              lastSeen,
            })}
            status={client.online ? 'Connected' : 'Not connected'}
            actions={<ActionButton danger disabled={Boolean(revokingClient)}
              onClick={() => {
                if (confirmClient !== client.id) {
                  setConfirmClient(client.id);
                  return;
                }
                if (!api.revokeRemoteAccessClient) return;
                setConfirmClient('');
                setRevokingClient(client.id);
                void api.revokeRemoteAccessClient(client.id)
                  .then((value) => {
                    const next = value ?? null;
                    setCachedConnectionInfo(api, next);
                    setInfo(next);
                  })
                  .catch(() => { /* retain the current list */ })
                  .finally(() => setRevokingClient(''));
              }}>
              {revokingClient === client.id
                ? 'Unpairing…'
                : confirmClient === client.id ? 'Confirm unpair' : 'Unpair'}
            </ActionButton>} />;
        })}
      </div>
      <ResourceRow title="Unpair every device"
        description="Every device approved so far loses access and must be approved again."
        actions={<ActionButton disabled={rotating} onClick={() => {
          if (!confirmRotate) {
            setConfirmRotate(true);
            return;
          }
          if (!api.rotateRemoteAccess) return;
          setConfirmRotate(false);
          setRotating(true);
          void api.rotateRemoteAccess()
            .then((value) => {
              const next = value ?? null;
              setCachedConnectionInfo(api, next);
              setInfo(next);
            })
            .catch(() => { /* retain the current card */ })
            .finally(() => setRotating(false));
        }}>
          {rotating ? 'Unpairing…' : confirmRotate ? 'Confirm unpair' : 'Unpair'}
        </ActionButton>} />
    </Group>}
  </>;
}

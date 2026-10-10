import { useEffect, useState } from 'react';
import type { DesktopRemoteAccessInfo } from '../../shared/contract';
import { nativeAppInfo } from '../../shared/native-app';
import { t, uiFormatLocale } from '../i18n';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { copyTextToClipboard } from '../text-format';
import { RemoteHostsPanel } from './remote-hosts-panel';
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
const RELAY_CONNECTING_MESSAGE =
  'Connecting to the Mixdog relay… this card refreshes automatically. If this persists, check this PC’s internet connection.';

function unpairLabel(busy: boolean, confirming: boolean): string {
  if (busy) return t('Unpairing…');
  return confirming ? t('Confirm unpair') : t('Unpair');
}

/** Keeps the pairing card current: a ready card polls for device changes, and
 *  a card still waiting on the relay retries until one arrives. */
function useConnectionInfoUpdates({
  api,
  ready,
  applyInfo,
  setInfo,
  setStalledAttempts,
}: {
  api: CapabilityApi;
  ready: boolean;
  applyInfo(next: DesktopRemoteAccessInfo | null): void;
  setInfo(next: DesktopRemoteAccessInfo | null): void;
  setStalledAttempts(update: (count: number) => number): void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: applyInfo is a per-render callback; the poll restarts only when ready or api change.
  useEffect(() => {
    if (!ready || !api.getRemoteAccessInfo) return undefined;
    let live = true;
    const refresh = () => {
      void api
        .getRemoteAccessInfo?.()
        .then((value) => {
          if (!live) return;
          applyInfo(value ?? null);
        })
        .catch(() => {
          /* retain the current card */
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    const unsubscribe = subscribeSetupChanges(refresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [ready, api]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: setInfo/setStalledAttempts are per-render callbacks; the retry loop restarts only when api or ready change.
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
        timer = window.setTimeout(attempt, Math.max(0, CONNECTION_RETRY_MS - (Date.now() - startedAt)));
      });
    };
    attempt();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, ready]);
}

// Both unpair flows answer with the refreshed card; a failed call keeps the
// card the user is looking at.
function applyConnectionResult(
  pending: Promise<DesktopRemoteAccessInfo | null | undefined>,
  applyInfo: (next: DesktopRemoteAccessInfo | null) => void,
  done: () => void
): void {
  void pending
    .then((value) => applyInfo(value ?? null))
    .catch(() => {
      /* retain the current card */
    })
    .finally(done);
}

function renderConnectionNote(message: string) {
  return (
    <Group title={t('Web app')}>
      <p className="settings-connection-note">{message}</p>
    </Group>
  );
}

function renderPairingPlaceholder() {
  return (
    <Group title={t('Web app')} description={t('Works on any network. Open the secure link in a browser.')}>
      <div className="settings-connection-grid">
        <figure
          className="settings-connection-card settings-connection-card--loading"
          aria-label={t('Preparing pairing code')}
          aria-busy="true"
        >
          <div className="settings-connection-qr-placeholder" aria-hidden="true" />
          <figcaption>
            <b>{t('Preparing pairing code…')}</b>
            <small>{t('Starting the secure relay')}</small>
          </figcaption>
        </figure>
      </div>
    </Group>
  );
}

// Each device row and the unpair-everything row confirm in place: the first
// click arms the button, the second one performs the revocation.
function renderLinkedDevices({
  info,
  api,
  rotating,
  confirmRotate,
  revokingClient,
  confirmClient,
  setRotating,
  setConfirmRotate,
  setRevokingClient,
  setConfirmClient,
  applyInfo,
}: {
  info: DesktopRemoteAccessInfo;
  api: CapabilityApi;
  rotating: boolean;
  confirmRotate: boolean;
  revokingClient: string;
  confirmClient: string;
  setRotating(value: boolean): void;
  setConfirmRotate(value: boolean): void;
  setRevokingClient(value: string): void;
  setConfirmClient(value: string): void;
  applyInfo(next: DesktopRemoteAccessInfo | null): void;
}) {
  return (
    <Group title={t('Linked devices')} description={t('Review and revoke browsers paired with this desktop.')}>
      <div className="settings-resource-list">
        {info.clients.map((client) => {
          const lastSeen = client.lastSeenAt
            ? new Date(client.lastSeenAt).toLocaleString(uiFormatLocale())
            : t('Never');
          return (
            <ResourceRow
              key={client.id}
              title={client.name || `${client.platform || t('Device')} · ${client.browser || t('Browser')}`}
              meta={
                t('Added {{created}} · Last used {{lastSeen}}', {
                  created: new Date(client.createdAt).toLocaleDateString(uiFormatLocale()),
                  lastSeen,
                })
              }
              status={client.online ? 'Connected' : 'Not connected'}
              actions={
                <ActionButton
                  danger
                  disabled={Boolean(revokingClient)}
                  onClick={() => {
                    if (confirmClient !== client.id) {
                      setConfirmClient(client.id);
                      return;
                    }
                    if (!api.revokeRemoteAccessClient) return;
                    setConfirmClient('');
                    setRevokingClient(client.id);
                    applyConnectionResult(api.revokeRemoteAccessClient(client.id), applyInfo, () =>
                      setRevokingClient('')
                    );
                  }}
                >
                  {unpairLabel(revokingClient === client.id, confirmClient === client.id)}
                </ActionButton>
              }
            />
          );
        })}
      </div>
      <ResourceRow
        title={t('Unpair every device')}
        description={t('Every device approved so far loses access and must be approved again.')}
        actions={
          <ActionButton
            disabled={rotating}
            onClick={() => {
              if (!confirmRotate) {
                setConfirmRotate(true);
                return;
              }
              if (!api.rotateRemoteAccess) return;
              setConfirmRotate(false);
              setRotating(true);
              applyConnectionResult(api.rotateRemoteAccess(), applyInfo, () => setRotating(false));
            }}
          >
            {unpairLabel(rotating, confirmRotate)}
          </ActionButton>
        }
      />
    </Group>
  );
}

export function ConnectionPanel({ api }: { api: CapabilityApi }) {
  const [info, setInfo] = useState<DesktopRemoteAccessInfo | null | undefined>(() => getCachedConnectionInfo(api));
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [revokingClient, setRevokingClient] = useState('');
  const [confirmClient, setConfirmClient] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [stalledAttempts, setStalledAttempts] = useState(0);
  const ready = connectionInfoReady(info);
  const applyInfo = (next: DesktopRemoteAccessInfo | null): void => {
    setCachedConnectionInfo(api, next);
    setInfo(next);
  };

  useConnectionInfoUpdates({ api, ready, applyInfo, setInfo, setStalledAttempts });

  if (!api.getRemoteAccessInfo) {
    const remoteServer = (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
    const note = renderConnectionNote(
      remoteServer
        ? t(
            'This web app is paired and connected through {{server}}. Pairing QR codes for other browsers live in the desktop app under Settings → Connection.',
            { server: remoteServer }
          )
        : t(RELAY_CONNECTING_MESSAGE)
    );
    const native = nativeAppInfo();
    if (!native?.call) return note;
    // The phone app keeps a list of paired PCs on its own pairing screen.
    return (
      <>
        {note}
        <Group title={t('Switch PC')}>
          <ResourceRow
            title={t('Switch PC / pair another PC')}
            description={t('Go back to the Mixdog app’s start screen to pick another paired PC or scan a new QR code.')}
            actions={<ActionButton onClick={() => void native.call?.('openHostPicker').catch(() => undefined)}>{t('Switch PC')}</ActionButton>}
          />
        </Group>
      </>
    );
  }

  // Connecting OUT to another PC does not depend on this PC's own relay.
  const hosts = <RemoteHostsPanel api={api} />;
  if (!ready) {
    return (
      <>
        {stalledAttempts >= CONNECTION_STALLED_ATTEMPTS
          ? renderConnectionNote(t(RELAY_CONNECTING_MESSAGE))
          : renderPairingPlaceholder()}
        {hosts}
      </>
    );
  }

  const copyLink = (): void => {
    void copyTextToClipboard(info.relayBrowserUrl).then(
      () => {
        setLinkCopied(true);
        window.setTimeout(() => setLinkCopied(false), 2_000);
      },
      () => undefined
    );
  };

  return (
    <>
      <Group
        title={t('Web app')}
        description={t('Works on any network. Scan to install the app, then approve it here.')}
      >
        <div className="settings-connection-grid">
          <figure className="settings-connection-card">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: QR SVG generated by the app's own relay info, not user content. */}
            <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: info.relayBrowserQrSvg || '' }} />
            <figcaption>
              <b>{t('Scan to install the web app')}</b>
              <small>{t('Chrome/Edge: Install app · Safari: Add to Home Screen')}</small>
            </figcaption>
          </figure>
        </div>
        {/* The same URL the QR encodes, for pasting into another PC's Mixdog
            ("Connect to another PC"). It names this desktop; it grants nothing. */}
        <div className="settings-connection-link">
          <input
            type="text"
            readOnly
            value={info.relayBrowserUrl}
            aria-label={t('Pairing link')}
            onFocus={(event) => event.currentTarget.select()}
          />
          <ActionButton onClick={copyLink}>{linkCopied ? t('Copied') : t('Copy link')}</ActionButton>
        </div>
      </Group>
      {info.clients.length > 0 &&
        renderLinkedDevices({
          info,
          api,
          rotating,
          confirmRotate,
          revokingClient,
          confirmClient,
          setRotating,
          setConfirmRotate,
          setRevokingClient,
          setConfirmClient,
          applyInfo,
        })}
      {hosts}
    </>
  );
}

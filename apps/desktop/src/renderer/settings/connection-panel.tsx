import { ExternalLink, Monitor, Plus, Server, Terminal, Wifi } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type {
  DesktopRemoteAccessInfo,
  DesktopRemoteClientInfo,
  DesktopRemoteHost,
  DesktopSshHost,
} from '../../shared/contract';
import { nativeAppInfo } from '../../shared/native-app';
import { remoteClientKind } from '../../shared/remote-trust';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { deviceKindText, deviceTitle } from '../remote-client-kind-label';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { ActionButton, CompactSwitch, Group, ResourceRow } from './capability-controls';
import type { CapabilityApi } from './capability-data';
import {
  connectionInfoReady,
  getCachedConnectionInfo,
  preloadConnectionInfo,
  setCachedConnectionInfo,
} from './connection-info';
import { ConfirmDialog, ConnectDeviceDialog, RenameDialog } from './connection-dialogs';
import {
  type ConnectionDialogRequest,
  type SshHostRequest,
  subscribeConnectionDialogRequests,
  takeConnectionDialogRequest,
  takeSshHostRequest,
} from './connection-intent';
import { ConnRow, KindIcon } from './connection-ui';
import { useRemoteAccessSettings } from './remote-access-settings';
import { OpenPcDialog, savedHostOnline, useRemoteHosts } from './remote-hosts-panel';
import { relativeWhen } from './relative-when';
import { SshConnectDialog } from './ssh-connect-dialog';
import { SshCleanupDialog, SshHostSettingsDialog } from './ssh-host-dialogs';
import { openSshHost, useSshHosts } from './ssh-hosts';
import { ReopenServerWindowsToggle } from './reopen-server-windows-toggle';
import { notificationSummary, requestNotificationDevice, useNotificationPreferences } from './notification-state';
import type { SettingsCategory } from './settings-items';
import { errorMessage } from '../editor-pane-session-errors';

const CONNECTION_RETRY_MS = 2_000;
const CONNECTION_STALLED_ATTEMPTS = 5;
const RELAY_CONNECTING_MESSAGE =
  'Connecting… This refreshes automatically. If it takes long, check this PC’s internet connection.';

function disconnectLabel(busy: boolean, confirming: boolean): string {
  if (busy) return t('Disconnecting…');
  return confirming ? t('Confirm disconnect') : t('Disconnect');
}

/** Keeps the device list current: a ready page polls for device changes, and
 *  one still waiting on the relay retries until it answers. */
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
          /* retain the current list */
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
        if (value?.enabled === false || connectionInfoReady(value)) return;
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

// Both unpair flows answer with the refreshed list; a failed call keeps the
// list the user is looking at.
function applyConnectionResult(
  pending: Promise<DesktopRemoteAccessInfo | null | undefined>,
  applyInfo: (next: DesktopRemoteAccessInfo | null) => void,
  done: () => void
): void {
  void pending
    .then((value) => applyInfo(value ?? null))
    .catch(() => {
      /* retain the current list */
    })
    .finally(done);
}

function renderConnectionNote(message: string) {
  return (
    <Group title={nativeAppInfo() ? t('Mixdog app') : t('Web app')}>
      <p className="settings-connection-note">{message}</p>
    </Group>
  );
}

type Dialog =
  | { kind: 'connect' }
  | { kind: 'open-pc' }
  | { kind: 'rename-self' }
  | { kind: 'rename-host'; host: DesktopRemoteHost }
  | { kind: 'rename-client'; client: DesktopRemoteClientInfo }
  | { kind: 'disconnect-all' }
  | { kind: 'forget'; host: DesktopRemoteHost }
  | { kind: 'ssh'; host: SshHostRequest | null }
  | { kind: 'rename-ssh'; host: DesktopSshHost }
  | { kind: 'settings-ssh'; host: DesktopSshHost }
  | { kind: 'cleanup-ssh'; host: DesktopSshHost }
  | { kind: 'forget-ssh'; host: DesktopSshHost };

/** The dialog a request from outside (title-bar menu, notice) asks for. */
function dialogForRequest(requested: ConnectionDialogRequest): Dialog {
  if (requested === 'ssh' || requested === 'ssh-host') return { kind: 'ssh', host: takeSshHostRequest() };
  return { kind: requested };
}

export function ConnectionPanel({
  api,
  openCategory,
}: {
  api: CapabilityApi;
  openCategory?: (category: SettingsCategory) => void;
}) {
  const { state: notifications } = useNotificationPreferences(api);
  const [info, setInfo] = useState<DesktopRemoteAccessInfo | null | undefined>(() => getCachedConnectionInfo(api));
  const [rotating, setRotating] = useState(false);
  const [revokingClient, setRevokingClient] = useState('');
  const [confirmClient, setConfirmClient] = useState('');
  const [stalledAttempts, setStalledAttempts] = useState(0);
  const [toggling, setToggling] = useState(false);
  const [hostBusy, setHostBusy] = useState('');
  const [hostError, setHostError] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(() => {
    const requested = takeConnectionDialogRequest();
    return requested ? dialogForRequest(requested) : null;
  });
  const [settings, setSettings, settingsSettled] = useRemoteAccessSettings(api);
  const { hosts, refresh: refreshHosts } = useRemoteHosts(api);
  const { hosts: sshHosts, refresh: refreshSshHosts } = useSshHosts(api);
  const enabled = settings ? settings.enabled : info?.enabled !== false;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(
    () =>
      subscribeConnectionDialogRequests(() => {
        const requested = takeConnectionDialogRequest();
        if (requested && (requested !== 'connect' || enabledRef.current)) setDialog(dialogForRequest(requested));
      }),
    []
  );
  // A switched-off page has no relay QR, but its device list is still real.
  const ready = Boolean(info) && (info?.enabled === false || connectionInfoReady(info));
  const applyInfo = (next: DesktopRemoteAccessInfo | null): void => {
    setCachedConnectionInfo(api, next);
    setInfo(next);
  };

  useConnectionInfoUpdates({ api, ready, applyInfo, setInfo, setStalledAttempts });

  if (!api.getRemoteAccessInfo) {
    const remoteServer = (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
    const note = renderConnectionNote(
      remoteServer
        ? t('Connected through {{server}}. To add devices, go to Settings > Connection on your PC.', {
            server: remoteServer,
          })
        : t(RELAY_CONNECTING_MESSAGE)
    );
    const native = nativeAppInfo();
    if (!native?.call) return note;
    // The phone app keeps its list of PCs on its own start screen.
    return (
      <>
        {note}
        <Group title={t('Switch PC')}>
          <ResourceRow
            title={t('Switch or add a PC')}
            description={t('Pick another PC or add one from the app’s start screen.')}
            actions={
              <ActionButton onClick={() => void native.call?.('openHostPicker').catch(() => undefined)}>
                {t('Switch PC')}
              </ActionButton>
            }
          />
        </Group>
      </>
    );
  }

  const closeDialog = () => setDialog(null);
  const toggle = (next: boolean): void => {
    setToggling(true);
    void Promise.resolve(api.setRemoteAccessEnabled?.(next))
      .then((value) => {
        if (value) setSettings(value);
        return api.getRemoteAccessInfo?.();
      })
      .then((value) => value !== undefined && applyInfo(value ?? null))
      .catch(() => undefined)
      .finally(() => setToggling(false));
  };
  const runHost = (key: string, action: () => Promise<unknown> | undefined): void => {
    setHostBusy(key);
    setHostError('');
    void Promise.resolve()
      .then(action)
      .then(refreshHosts)
      .catch((reason) => setHostError(errorMessage(reason)))
      .finally(() => setHostBusy(''));
  };

  const clients = ready && info ? info.clients : [];
  const revokeClient = (id: string): void => {
    if (!api.revokeRemoteAccessClient) return;
    setConfirmClient('');
    setRevokingClient(id);
    applyConnectionResult(api.revokeRemoteAccessClient(id), applyInfo, () => setRevokingClient(''));
  };

  // Until the host answers, the card's two 56px rows are held empty so the
  // toolbar and lists below do not jump down when it arrives.
  const identityPending = !settings && !settingsSettled && Boolean(api.getRemoteAccessSettings);
  let identity: ReactNode = null;
  if (identityPending) {
    identity = (
      <div className="conn-card" aria-hidden="true">
        <div className="conn-row" />
        <div className="conn-row" />
      </div>
    );
  } else if (settings) {
    identity = (
      <div className="conn-card">
        <ConnRow
          icon={<Monitor size={16} aria-hidden="true" />}
          title={settings.name}
          meta={
            settings.name === settings.defaultName
              ? t('This PC · Default name (computer name)')
              : t('This PC · Computer name {{name}}', { name: settings.defaultName })
          }
          actions={
            <button type="button" className="conn-btn conn-btn--sm" onClick={() => setDialog({ kind: 'rename-self' })}>
              {t('Rename')}
            </button>
          }
        />
        <div className="conn-row">
          <span className="conn-tile">
            <Wifi size={16} aria-hidden="true" />
          </span>
          <div className="conn-row-text">
            <div className="conn-row-title">
              <span>{t('Use this PC from other devices')}</span>
            </div>
            <div className="conn-row-meta">
              {enabled
                ? t('Phones, browsers and other PCs can connect.')
                : t('Off. Connected devices can’t use this PC for now.')}
            </div>
          </div>
          <CompactSwitch
            label={t('Use this PC from other devices')}
            checked={enabled}
            disabled={toggling}
            optimistic={false}
            onChange={toggle}
          />
        </div>
      </div>
    );
  }

  let devices: ReactNode = null;
  if (ready) {
    devices = (
      <section className={`conn-group${enabled ? '' : ' is-dimmed'}`}>
        <div className="conn-group-head">
          <h4>
            {t('Devices connected to this PC')}
            <span>{clients.length}</span>
          </h4>
          {clients.length > 1 && (
            <button
              type="button"
              className="conn-link conn-link--danger"
              disabled={rotating}
              onClick={() => setDialog({ kind: 'disconnect-all' })}
            >
              {t('Disconnect all')}
            </button>
          )}
        </div>
        {clients.length === 0 && <p className="conn-empty">{t('No connected devices.')}</p>}
        {clients.length > 0 && (
          <div className="conn-list">
            {clients.map((client) => {
              const kind = remoteClientKind(client.browser);
              const lastSeen = client.lastSeenAt ? relativeWhen(client.lastSeenAt) : t('Not used yet');
              let status = t('Off');
              if (client.pendingRemoval) status = t('Removing…');
              else if (enabled) status = client.online ? t('Online') : t('Offline');
              const defaultTitle = deviceTitle(client, kind);
              const baseMeta = `${deviceKindText(client, kind)} · ${lastSeen}`;
              const device = notifications?.devices.find((entry) => entry.id === client.id);
              const summary = device ? notificationSummary(device, notifications?.preferences[client.id]) : null;
              return (
                <ConnRow
                  key={client.id}
                  icon={<KindIcon kind={kind} />}
                  title={client.alias || defaultTitle}
                  status={status}
                  statusTone={enabled && client.online && !client.pendingRemoval ? 'on' : 'off'}
                  meta={client.alias ? `${defaultTitle} · ${baseMeta}` : baseMeta}
                  extra={
                    summary &&
                    (summary.muted ? (
                      <div className="conn-notif conn-notif--off">{summary.text}</div>
                    ) : (
                      <button
                        type="button"
                        className="conn-link conn-notif"
                        onClick={() => {
                          requestNotificationDevice(client.id);
                          openCategory?.('notifications');
                        }}
                      >
                        {summary.text}
                      </button>
                    ))
                  }
                  actions={
                    <>
                      {api.setRemoteClientAlias && (
                        <button
                          type="button"
                          className="conn-btn conn-btn--sm"
                          disabled={Boolean(client.pendingRemoval)}
                          onClick={() => setDialog({ kind: 'rename-client', client })}
                        >
                          {t('Rename')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="conn-btn conn-btn--sm"
                        disabled={Boolean(revokingClient) || Boolean(client.pendingRemoval)}
                        onClick={() =>
                          confirmClient === client.id ? revokeClient(client.id) : setConfirmClient(client.id)
                        }
                      >
                        {client.pendingRemoval
                          ? t('Removing…')
                          : disconnectLabel(revokingClient === client.id, confirmClient === client.id)}
                      </button>
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </section>
    );
  } else if (enabled && stalledAttempts >= CONNECTION_STALLED_ATTEMPTS) {
    devices = renderConnectionNote(t(RELAY_CONNECTING_MESSAGE));
  }

  const savedHosts = hosts.length > 0 && (
    <section className="conn-group">
      <div className="conn-group-head">
        <h4>
          {t('PCs I opened')}
          <span>{hosts.length}</span>
        </h4>
      </div>
      <div className="conn-list">
        {hosts.map((host) => {
          const online = savedHostOnline(host);
          let status: string | undefined;
          if (online !== undefined) status = online ? t('Online') : t('Offline');
          return (
            <ConnRow
              key={host.id}
              icon={<Monitor size={16} aria-hidden="true" />}
              title={host.name}
              status={status}
              statusTone={online ? 'on' : 'off'}
              meta={
                host.lastConnectedAt
                  ? t('Last connected {{lastSeen}}', { lastSeen: relativeWhen(host.lastConnectedAt) })
                  : t('Not connected yet')
              }
              actions={
                <>
                  <button
                    type="button"
                    className="conn-btn conn-btn--sm"
                    disabled={Boolean(hostBusy)}
                    onClick={() => runHost(`open:${host.id}`, () => api.openRemoteHost?.(host.id))}
                  >
                    {t('Open')}
                  </button>
                  <button
                    type="button"
                    className="conn-btn conn-btn--sm"
                    disabled={Boolean(hostBusy)}
                    onClick={() => setDialog({ kind: 'rename-host', host })}
                  >
                    {t('Rename')}
                  </button>
                  <button
                    type="button"
                    className="conn-btn conn-btn--sm"
                    disabled={Boolean(hostBusy)}
                    onClick={() => setDialog({ kind: 'forget', host })}
                  >
                    {t('Forget')}
                  </button>
                </>
              }
            />
          );
        })}
      </div>
      {hostError && <ErrorNotice error={hostError} />}
    </section>
  );

  const sshGroup = sshHosts.length > 0 && (
    <section className="conn-group">
      <div className="conn-group-head">
        <h4>
          {t('SSH servers')}
          <span>{sshHosts.length}</span>
        </h4>
      </div>
      <div className="conn-list">
        {sshHosts.map((host) => (
          <ConnRow
            key={host.id}
            icon={<Server size={16} aria-hidden="true" />}
            title={host.name}
            status={host.open ? t('Online') : undefined}
            statusTone="on"
            meta={`${host.target} · ${
              host.lastConnectedAt
                ? t('Last connected {{lastSeen}}', { lastSeen: relativeWhen(host.lastConnectedAt) })
                : t('Not connected yet')
            }`}
            actions={
              <>
                <button
                  type="button"
                  className="conn-btn conn-btn--sm"
                  disabled={Boolean(hostBusy)}
                  onClick={() =>
                    void openSshHost(api, host, () =>
                      setDialog({ kind: 'ssh', host: { id: host.id, name: host.name, target: host.target } })
                    )
                  }
                >
                  {t('Open')}
                </button>
                <button
                  type="button"
                  className="conn-btn conn-btn--sm"
                  disabled={Boolean(hostBusy)}
                  onClick={() => setDialog({ kind: 'rename-ssh', host })}
                >
                  {t('Rename')}
                </button>
                <button
                  type="button"
                  className="conn-btn conn-btn--sm"
                  disabled={Boolean(hostBusy)}
                  onClick={() => setDialog({ kind: 'settings-ssh', host })}
                >
                  {t('Settings')}
                </button>
                {api.sshCleanupHost && (
                  <button
                    type="button"
                    className="conn-btn conn-btn--sm"
                    disabled={Boolean(hostBusy)}
                    onClick={() => setDialog({ kind: 'cleanup-ssh', host })}
                  >
                    {t('Clean up Mixdog on the server…')}
                  </button>
                )}
                <button
                  type="button"
                  className="conn-btn conn-btn--sm"
                  disabled={Boolean(hostBusy)}
                  onClick={() => setDialog({ kind: 'forget-ssh', host })}
                >
                  {t('Forget')}
                </button>
              </>
            }
          />
        ))}
      </div>
      <ReopenServerWindowsToggle api={api} />
      {!savedHosts && hostError && <ErrorNotice error={hostError} />}
    </section>
  );

  return (
    <div className="conn-page">
      {identity}
      <div className="conn-toolbar">
        {api.connectRemoteHostByCode && (
          <button type="button" className="conn-btn" onClick={() => setDialog({ kind: 'open-pc' })}>
            <ExternalLink size={16} aria-hidden="true" />
            {t('Open another PC')}
          </button>
        )}
        {api.sshConnect && (
          <button type="button" className="conn-btn" onClick={() => setDialog({ kind: 'ssh', host: null })}>
            <Terminal size={16} aria-hidden="true" />
            {t('Connect SSH server')}
          </button>
        )}
        <button
          type="button"
          className="conn-btn conn-btn--primary conn-connect-device"
          disabled={!enabled}
          onClick={() => setDialog({ kind: 'connect' })}
        >
          <Plus size={16} aria-hidden="true" />
          {t('Connect a device')}
        </button>
      </div>
      {devices}
      {savedHosts}
      {sshGroup}
      {dialog?.kind === 'connect' && <ConnectDeviceDialog api={api} info={info} onClose={closeDialog} />}
      {dialog?.kind === 'ssh' && (
        <SshConnectDialog api={api} host={dialog.host} onConnected={refreshSshHosts} onClose={closeDialog} />
      )}
      {dialog?.kind === 'rename-ssh' && (
        <RenameDialog
          title={t('Rename server')}
          description={t('Only this computer shows the new name.')}
          initial={dialog.host.name}
          allowEmpty={false}
          onSave={(name) => Promise.resolve(api.sshRenameHost?.(dialog.host.id, name)).then(refreshSshHosts)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'settings-ssh' && (
        <SshHostSettingsDialog api={api} host={dialog.host} onSaved={refreshSshHosts} onClose={closeDialog} />
      )}
      {dialog?.kind === 'cleanup-ssh' && (
        <SshCleanupDialog api={api} host={dialog.host} onDone={refreshSshHosts} onClose={closeDialog} />
      )}
      {dialog?.kind === 'forget-ssh' && (
        <ConfirmDialog
          title={t('Forget {{name}}', { name: dialog.host.name })}
          description={t('Only the saved entry for {{name}} is removed. The server itself is not changed.', {
            name: dialog.host.name,
          })}
          confirmLabel={t('Forget')}
          onConfirm={() =>
            runHost(`forget-ssh:${dialog.host.id}`, () => api.sshForgetHost?.(dialog.host.id).then(refreshSshHosts))
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'open-pc' && <OpenPcDialog api={api} onConnected={refreshHosts} onClose={closeDialog} />}
      {dialog?.kind === 'rename-self' && settings && (
        <RenameDialog
          title={t('This PC’s name')}
          description={t('Phones, browsers and other PCs show this name.')}
          helper={t('Leave empty to go back to the default name ({{defaultName}}).', {
            defaultName: settings.defaultName,
          })}
          initial={settings.name}
          allowEmpty
          onSave={(name) => Promise.resolve(api.setRemotePcName?.(name)).then((value) => value && setSettings(value))}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'rename-host' && (
        <RenameDialog
          title={t('Rename PC')}
          description={t('Only this computer shows the new name.')}
          initial={dialog.host.name}
          allowEmpty={false}
          onSave={(name) => Promise.resolve(api.renameRemoteHost?.(dialog.host.id, name)).then(refreshHosts)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'rename-client' && (
        <RenameDialog
          title={t('Rename device')}
          description={t('Only this computer shows the new name.')}
          helper={t('Leave empty to go back to the device’s own name.')}
          initial={dialog.client.alias || deviceTitle(dialog.client, remoteClientKind(dialog.client.browser))}
          allowEmpty
          onSave={(name) =>
            Promise.resolve(api.setRemoteClientAlias?.(dialog.client.id, name))
              .then(() => api.getRemoteAccessInfo?.())
              .then((value) => value !== undefined && applyInfo(value ?? null))
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'disconnect-all' && (
        <ConfirmDialog
          title={t('Disconnect all devices')}
          description={t(
            'Phones, browsers and other PCs ({{total}} devices) will be disconnected. To use them again, connect them again.',
            { total: clients.length }
          )}
          confirmLabel={t('Disconnect {{total}}', { total: clients.length })}
          onConfirm={() => {
            if (!api.rotateRemoteAccess) return;
            setRotating(true);
            applyConnectionResult(api.rotateRemoteAccess(), applyInfo, () => setRotating(false));
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'forget' && (
        <ConfirmDialog
          title={t('Forget {{name}}', { name: dialog.host.name })}
          description={t('The saved connection to {{name}} is removed. To open it again you need its code.', {
            name: dialog.host.name,
          })}
          confirmLabel={t('Forget')}
          onConfirm={() => runHost(`forget:${dialog.host.id}`, () => api.forgetRemoteHost?.(dialog.host.id))}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}

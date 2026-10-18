import { Check, ChevronDown, ExternalLink, Monitor, Plus, SlidersHorizontal, Terminal } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DesktopRemoteHost, DesktopSshHost } from '../shared/contract';
import { nativeAppInfo } from '../shared/native-app';
import { remoteWindowInfo, remoteWindowSwitcher } from '../shared/remote-window';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { OPEN_CONNECTION_SETTINGS_EVENT } from './remote-claim-events';
import {
  type ConnectionDialogRequest,
  requestConnectionDialog,
  type SshHostRequest,
} from './settings/connection-intent';
import { openSshHost } from './settings/ssh-hosts';
import { relativeWhen } from './settings/relative-when';
import { useRemoteAccessSettings } from './settings/remote-access-settings';
import { useRemoteHostName } from './remote-host-access';
import { currentRemoteConnectionState, subscribeRemoteConnectionState } from './remote-connection-state';
import { isRemoteBrowserRenderer } from './remote-ui-projection';
import { desktopConnection } from './desktop-connection';
import { useConnectionLink } from './connection-link-store';
import { loadWebSwitcherPcs, type SwitcherPc } from './remote-saved-pcs';

/** "In use" for the PC being driven ("This PC · In use" in the main window);
 *  else its presence and whether its window is open or when it last connected. */
function switcherPcDetail(pc: SwitcherPc): string {
  if (pc.ssh) {
    let rest = '';
    if (pc.windowOpen) rest = `${t('Online')} · ${t('Window open')}`;
    else if (pc.lastConnectedAt) rest = relativeWhen(pc.lastConnectedAt);
    return rest ? `SSH · ${rest}` : 'SSH';
  }
  if (pc.current) return pc.thisPc ? t('This PC · In use') : t('In use');
  const state = pc.online === true ? t('Online') : t('Offline');
  if (pc.windowOpen) return `${state} · ${t('Window open')}`;
  if (!pc.lastConnectedAt) return state;
  return `${state} · ${relativeWhen(pc.lastConnectedAt)}`;
}

/** The saved-PC state of a remote surface (phone, other-PC window, browser):
 *  the PC being driven, the others, whether the link is alive, and the
 *  switch / connect actions every PC menu shares. `reloadOn` re-reads the list
 *  (a menu opening). */
/** Whether this surface drives another PC (and so shows the PC card). */
export function remotePcSurface(): boolean {
  return Boolean(remoteWindowInfo()) || isRemoteBrowserRenderer();
}

function useRemotePcs(reloadOn: unknown = false) {
  const windowInfo = remoteWindowInfo();
  const bridge = remoteWindowSwitcher();
  const remote = remotePcSurface();
  const [pcs, setPcs] = useState<SwitcherPc[]>([]);
  const connectionState = useSyncExternalStore(
    subscribeRemoteConnectionState,
    currentRemoteConnectionState,
    () => null
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the list reloads when the menu opens, not on bridge identity.
  useEffect(() => {
    if (!remote) return undefined;
    let live = true;
    const load = () => {
      const pending = bridge ? bridge.listHosts() : loadWebSwitcherPcs();
      void Promise.resolve(pending)
        .then((next) => live && setPcs(next))
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [remote, reloadOn]);

  const announcedName = useRemoteHostName();
  // The saved-PC entry may have no name (the relay no longer serves it): fall
  // back to the name the connected PC announced in its handshake.
  const named = pcs.map((pc) => (pc.current && !pc.name && announcedName ? { ...pc, name: announcedName } : pc));
  const current = named.find((pc) => pc.current);
  const connected = current?.online !== false && connectionState !== 'connecting' && connectionState !== 'reconnecting';
  const connectAnother = (): void => {
    const native = nativeAppInfo();
    if (bridge) void bridge.manageConnections();
    else if (native?.call) void native.call('openHostPicker').catch(() => undefined);
    else location.assign('/connect');
  };
  const switchTo = (pc: SwitcherPc): void => {
    if (bridge) void bridge.openHost(pc.id);
    else location.assign(`/d/${pc.id}/`);
  };
  return {
    remote,
    pcs: named,
    current,
    others: named.filter((pc) => !pc.current),
    name: windowInfo?.hostName || current?.name || announcedName || t('PC'),
    connected,
    connectAnother,
    switchTo,
  };
}

/** Connection dot: green while the link to the PC is alive, grey otherwise. */
function PcDot({ connected, className = 'remote-pc-dot' }: { connected: boolean; className?: string }) {
  return <i className={`${className}${connected ? '' : ' off'}`} aria-hidden="true" />;
}

/** Small dot on the phone brand button (bottom-right) — a remote surface only. */
export function RemotePcBrandDot() {
  const { remote, connected } = useRemotePcs();
  if (!remote) return null;
  return <PcDot connected={connected} className="workspace-tab-home-dot" />;
}

/** "● <PC name>" label: settings group header and page badge. */
export function RemotePcLabel() {
  const { name, connected } = useRemotePcs();
  return (
    <>
      <PcDot connected={connected} />
      <span className="remote-pc-label-name">{name}</span>
    </>
  );
}

/** The main window's own PC and the computers saved here, for the title-bar
 *  chip: this PC is always the first row and in use. */
function useMainWindowPcs(reloadOn: unknown, enabled: boolean) {
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const [settings] = useRemoteAccessSettings(enabled ? api : undefined);
  const [hosts, setHosts] = useState<DesktopRemoteHost[]>([]);
  const listed = enabled && Boolean(api?.listRemoteHosts);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list reloads when the menu opens, not on bridge identity.
  useEffect(() => {
    if (!listed) return undefined;
    let live = true;
    const load = () => {
      void window.mixdogDesktop
        ?.listRemoteHosts?.()
        .then((next) => live && setHosts(next))
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [listed, reloadOn]);
  const [sshHosts, setSshHosts] = useState<DesktopSshHost[]>([]);
  const sshListed = enabled && Boolean(api?.sshListHosts);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list reloads when the menu opens, not on bridge identity.
  useEffect(() => {
    if (!sshListed) return undefined;
    let live = true;
    const load = () => {
      void window.mixdogDesktop
        ?.sshListHosts?.()
        .then((next) => live && setSshHosts(next))
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sshListed, reloadOn]);
  const thisPc: SwitcherPc = {
    id: '',
    name: settings?.name || t('This PC'),
    online: true,
    lastConnectedAt: null,
    current: true,
    thisPc: true,
  };
  const saved: SwitcherPc[] = hosts.map((host) => ({
    id: host.id,
    name: host.name,
    online: host.online ?? (host.open ? true : null),
    lastConnectedAt: host.lastConnectedAt,
    current: false,
    windowOpen: host.open,
  }));
  const savedSsh: SwitcherPc[] = sshHosts.map((host) => ({
    id: host.id,
    name: host.name,
    online: host.open ? true : null,
    lastConnectedAt: host.lastConnectedAt,
    current: false,
    windowOpen: host.open,
    ssh: true,
  }));
  return {
    main: (listed && saved.length > 0) || (sshListed && savedSsh.length > 0),
    pcs: [thisPc, ...saved, ...savedSsh],
    name: thisPc.name,
    sshHosts,
    sshListed,
  };
}

/** Opens Settings → Connection, optionally with one of its dialogs. */
function openConnectionSettings(dialog?: ConnectionDialogRequest, sshHost?: SshHostRequest): void {
  if (dialog) requestConnectionDialog(dialog, sshHost);
  window.dispatchEvent(new Event(OPEN_CONNECTION_SETTINGS_EVENT));
}

function PcMenuItems({
  pcs,
  onSwitch,
  onOpenPc,
  onSshConnect,
  onConnectDevice,
  onSettings,
}: {
  pcs: SwitcherPc[];
  onSwitch(pc: SwitcherPc): void;
  onOpenPc(): void;
  /** Only the main window's menu offers SSH servers. */
  onSshConnect?(): void;
  onConnectDevice(): void;
  onSettings(): void;
}) {
  return (
    <>
      {pcs.map((pc) => (
        <button
          key={pc.id}
          type="button"
          role="menuitem"
          className={`remote-pc-item${pc.current ? ' on' : ''}`}
          disabled={pc.current}
          onClick={() => onSwitch(pc)}
        >
          <i className={`remote-pc-dot${pc.online === true ? '' : ' off'}`} aria-hidden="true" />
          <span>
            {pc.name || t('PC')}
            <small>{switcherPcDetail(pc)}</small>
          </span>
          {pc.current && <Check size={14} aria-hidden="true" />}
        </button>
      ))}
      {pcs.length > 0 && <div className="remote-pc-sep" />}
      <button type="button" role="menuitem" className="mx-menu-item remote-pc-action" onClick={onOpenPc}>
        <ExternalLink size={14} aria-hidden="true" />
        <span>{t('Open another PC')}</span>
      </button>
      {onSshConnect && (
        <button type="button" role="menuitem" className="mx-menu-item remote-pc-action" onClick={onSshConnect}>
          <Terminal size={14} aria-hidden="true" />
          <span>{t('Connect SSH server')}</span>
        </button>
      )}
      <button type="button" role="menuitem" className="mx-menu-item remote-pc-action" onClick={onConnectDevice}>
        <Plus size={14} aria-hidden="true" />
        <span>{t('Connect a device')}</span>
      </button>
      <button type="button" role="menuitem" className="mx-menu-item remote-pc-action" onClick={onSettings}>
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>{t('Connection settings')}</span>
      </button>
    </>
  );
}

/** Top of the phone session drawer: the PC being driven with its link state;
 *  with several saved PCs, tapping opens the PC list. */
export function RemotePcCard() {
  const [open, setOpen] = useState(false);
  useMobileBack(open, () => setOpen(false));
  const { remote, pcs, others, name, connected, connectAnother, switchTo } = useRemotePcs(open);
  if (!remote) return null;
  const head = (
    <>
      <span className="remote-pc-card-name">
        <PcDot connected={connected} />
        <span>{name}</span>
        {others.length > 0 && <ChevronDown size={14} aria-hidden="true" />}
      </span>
    </>
  );
  return (
    <div className="remote-pc-card">
      {others.length === 0 ? (
        <div className="remote-pc-card-head" role="status">
          {head}
        </div>
      ) : (
        <button
          type="button"
          className="remote-pc-card-head"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {head}
        </button>
      )}
      {open && (
        <div className="remote-pc-card-menu" role="menu">
          <PcMenuItems
            pcs={pcs}
            onSwitch={(pc) => {
              setOpen(false);
              switchTo(pc);
            }}
            onOpenPc={() => {
              setOpen(false);
              connectAnother();
            }}
            onConnectDevice={() => {
              setOpen(false);
              connectAnother();
            }}
            onSettings={() => {
              setOpen(false);
              connectAnother();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The switcher's trigger: "● <PC name> ▾" in the title band; on the rail a
 *  compact icon cell whose dot carries the link state and whose name is the
 *  tooltip and accessible label. */
function SwitcherButton({
  rail,
  open,
  connected,
  name,
  title,
  onToggle,
}: {
  rail: boolean;
  open: boolean;
  connected: boolean;
  name: string;
  title?: string;
  onToggle(): void;
}) {
  if (rail) {
    return (
      <button
        type="button"
        className="remote-pc-button remote-pc-rail-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        data-tooltip={open ? undefined : title || name}
        onClick={onToggle}
      >
        <Monitor size={24} aria-hidden="true" />
        <PcDot connected={connected} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="remote-pc-name remote-pc-button"
      aria-haspopup="menu"
      aria-expanded={open}
      title={title}
      onClick={onToggle}
    >
      <PcDot connected={connected} />
      <span className="remote-pc-label">{name}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>
  );
}

/** PC button at the title band's leading edge, or at the top of the activity
 *  rail in a plain browser tab (which has no band). A remote surface (another
 *  PC's window, tablet/browser) shows "● <PC name> ▾"; the main window shows
 *  this PC's name the same way once other PCs are saved, and nothing before. */
export function RemotePcSwitcher({ placement = 'titlebar' }: { placement?: 'titlebar' | 'rail' } = {}) {
  const rail = placement === 'rail';
  const switcherClass = rail ? 'remote-pc-switcher remote-pc-switcher-rail' : 'remote-pc-switcher';
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useMobileBack(open, () => setOpen(false));
  const { remote, pcs, name, connected, connectAnother, switchTo } = useRemotePcs(open);
  // A server (ssh) window names the server it drives, not this PC.
  const server = desktopConnection();
  const serverWindow = server?.kind === 'ssh';
  const mainPcs = useMainWindowPcs(open, !remote && !serverWindow);
  const serverLink = useConnectionLink();

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  if (server && serverWindow) {
    const linked = serverLink?.state.status !== 'reconnecting' && serverLink?.state.status !== 'lost';
    const rtt = serverLink?.rttMs;
    return (
      <div className={switcherClass} ref={root}>
        <SwitcherButton
          rail={rail}
          open={open}
          connected={linked}
          name={server.name}
          title={rtt == null ? server.name : `${server.name} · ${t('Round trip {{ms}} ms', { ms: rtt })}`}
          onToggle={() => setOpen((value) => !value)}
        />
        {open && (
          <div className="remote-pc-menu" role="menu">
            <button type="button" role="menuitem" className="remote-pc-item on" disabled>
              <i className={`remote-pc-dot${linked ? '' : ' off'}`} aria-hidden="true" />
              <span>
                {server.name}
                <small>{t('In use')}</small>
                {/* Where each part of a server turn runs. */}
                <small>{t('Model: this PC’s sign-in · Files & tools: {{name}}', { name: server.name })}</small>
              </span>
              <Check size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    );
  }

  const main = mainPcs.main;
  if (!remote && !main) return null;

  const shownPcs = main ? mainPcs.pcs : pcs;
  // A window that is open is focused; otherwise Settings → Connection opens
  // with the connect dialog on that server (progress and guidance live there).
  const openSavedSsh = (pc: SwitcherPc): void => {
    const host = mainPcs.sshHosts.find((entry) => entry.id === pc.id);
    const api = window.mixdogDesktop;
    if (!host || !api) return;
    void openSshHost(api, host, () =>
      openConnectionSettings('ssh-host', { id: host.id, name: host.name, target: host.target })
    );
  };
  const act = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div className={switcherClass} ref={root}>
      <SwitcherButton
        rail={rail}
        open={open}
        connected={main || connected}
        name={main ? mainPcs.name : name}
        onToggle={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="remote-pc-menu" role="menu">
          <PcMenuItems
            pcs={shownPcs}
            onSwitch={(pc) => {
              setOpen(false);
              if (!main) switchTo(pc);
              else if (pc.ssh) openSavedSsh(pc);
              else void window.mixdogDesktop?.openRemoteHost?.(pc.id)?.catch(() => undefined);
            }}
            onOpenPc={act(() => (main ? openConnectionSettings('open-pc') : connectAnother()))}
            onSshConnect={main && mainPcs.sshListed ? act(() => openConnectionSettings('ssh')) : undefined}
            onConnectDevice={act(() => (main ? openConnectionSettings('connect') : connectAnother()))}
            onSettings={act(() => (main ? openConnectionSettings() : connectAnother()))}
          />
        </div>
      )}
    </div>
  );
}

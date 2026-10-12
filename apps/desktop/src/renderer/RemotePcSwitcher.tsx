import { Check, ChevronDown, ExternalLink, Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DesktopRemoteHost } from '../shared/contract';
import { nativeAppInfo } from '../shared/native-app';
import { remoteWindowInfo, remoteWindowSwitcher } from '../shared/remote-window';
import { t } from './i18n';
import { OPEN_CONNECTION_SETTINGS_EVENT } from './remote-claim-events';
import { requestConnectionDialog } from './settings/connection-intent';
import { relativeWhen } from './settings/relative-when';
import { useRemoteAccessSettings } from './settings/remote-access-settings';
import { useRemoteHostName } from './remote-host-access';
import { currentRemoteConnectionState, subscribeRemoteConnectionState } from './remote-connection-state';
import { isRemoteBrowserRenderer } from './remote-ui-projection';
import { loadWebSwitcherPcs, type SwitcherPc } from './remote-saved-pcs';

/** "In use" for the PC being driven ("This PC · In use" in the main window);
 *  else its presence and whether its window is open or when it last connected. */
function switcherPcDetail(pc: SwitcherPc): string {
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
function useRemotePcs(reloadOn: unknown = false) {
  const windowInfo = remoteWindowInfo();
  const bridge = remoteWindowSwitcher();
  const remote = Boolean(windowInfo) || isRemoteBrowserRenderer();
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
  return { main: listed && saved.length > 0, pcs: [thisPc, ...saved], name: thisPc.name };
}

/** Opens Settings → Connection, optionally with one of its dialogs. */
function openConnectionSettings(dialog?: 'connect' | 'open-pc'): void {
  if (dialog) requestConnectionDialog(dialog);
  window.dispatchEvent(new Event(OPEN_CONNECTION_SETTINGS_EVENT));
}

function PcMenuItems({
  pcs,
  onSwitch,
  onOpenPc,
  onConnectDevice,
  onSettings,
}: {
  pcs: SwitcherPc[];
  onSwitch(pc: SwitcherPc): void;
  onOpenPc(): void;
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
      <div className="remote-pc-sep" />
      <button type="button" role="menuitem" className="remote-pc-item remote-pc-action" onClick={onOpenPc}>
        <ExternalLink size={14} aria-hidden="true" />
        <span>{t('Open another PC')}</span>
      </button>
      <button type="button" role="menuitem" className="remote-pc-item remote-pc-action" onClick={onConnectDevice}>
        <Plus size={14} aria-hidden="true" />
        <span>{t('Connect a device')}</span>
      </button>
      <button type="button" role="menuitem" className="remote-pc-item remote-pc-action" onClick={onSettings}>
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

/** Title-bar PC button at the leading edge. A remote surface (another PC's
 *  window, tablet/browser) shows "● <PC name> ▾"; the main window shows this
 *  PC's name the same way once other PCs are saved, and nothing before. */
export function RemotePcSwitcher() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { remote, pcs, name, connected, connectAnother, switchTo } = useRemotePcs(open);
  const mainPcs = useMainWindowPcs(open, !remote);

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

  const main = mainPcs.main;
  if (!remote && !main) return null;

  const shownPcs = main ? mainPcs.pcs : pcs;
  const act = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div className="remote-pc-switcher" ref={root}>
      <button
        type="button"
        className="remote-pc-name remote-pc-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PcDot connected={main || connected} />
        <span className="remote-pc-label">{main ? mainPcs.name : name}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="remote-pc-menu" role="menu">
          <PcMenuItems
            pcs={shownPcs}
            onSwitch={(pc) => {
              setOpen(false);
              if (main) void window.mixdogDesktop?.openRemoteHost?.(pc.id)?.catch(() => undefined);
              else switchTo(pc);
            }}
            onOpenPc={act(() => (main ? openConnectionSettings('open-pc') : connectAnother()))}
            onConnectDevice={act(() => (main ? openConnectionSettings('connect') : connectAnother()))}
            onSettings={act(() => (main ? openConnectionSettings() : connectAnother()))}
          />
        </div>
      )}
    </div>
  );
}

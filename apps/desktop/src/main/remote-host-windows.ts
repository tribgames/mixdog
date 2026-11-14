// The dedicated Electron window for "Connect to another PC": it loads the
// host's relay web app and runs the ordinary web pairing/claim flow in its own
// persistent session partition (one per host). It gets only the tiny
// remote-window preload — never the local desktop bridge — so the page installs
// the remote shim and every host action keeps going through the E2EE relay.
// Local conveniences (native file picker for attachments, OS notifications,
// links in the default browser) are this machine's own Chromium/Electron
// features and need no bridge into the host.
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';

import type {
  ConnectionsIdParams,
  ConnectionsRenameParams,
  RemoteHost,
  RemoteHostPresenceParams,
  RemoteHostPresenceResult,
  RemoteHostRedeemParams,
} from '../../../../packages/protocol/src/index.ts';
import type { DesktopRemoteHost } from '../shared/contract';
import type { CoreCaller } from './connections/server-window-record';
import { nativeT } from './native-i18n';
import { REMOTE_HOST_ARGUMENT, REMOTE_WINDOW_IPC, type RemoteWindowHostEntry } from '../shared/remote-window';
import { notifyHostListsChanged } from './host-lists-changed';
import {
  externalLinkTarget,
  isRemoteHostNavigation,
  remoteHostPartition,
  remoteWindowTitle,
  remoteWindowUserAgent,
} from './remote-hosts';
import {
  DESKTOP_BACKGROUND_COLOR,
  DESKTOP_LIGHT_BACKGROUND_COLOR,
  DESKTOP_TITLEBAR_WINDOW_OPTIONS,
  setWindowTitleBarBand,
} from './window-options';

const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

export interface RemoteHostWindows {
  list(): Promise<DesktopRemoteHost[]>;
  /** Redeems a 6-digit code on this machine's relay, saves the host it names
   *  and opens its window, which asks that host for approval. */
  connectByCode(code: string): Promise<DesktopRemoteHost>;
  open(id: string): Promise<DesktopRemoteHost[]>;
  forget(id: string): Promise<DesktopRemoteHost[]>;
  /** Local alias for a saved PC; empty resets to its announced name. */
  rename(id: string, name: string): Promise<void>;
}

/** The one-time proof the relay redeemed a code rides the redeem answer next to the host (the core answers it for
 *  the first claim; a list never carries it). */
type RedeemedHost = RemoteHost & { ticket?: unknown };

/** `preloadPath` comes from the main entry: this module is a lazily loaded
 *  chunk, so a path relative to its own directory would miss `out/preload`.
 *  The saved hosts, the code redemption and the presence are this PC's core (`remoteHosts/*`); `core` calls it. */
export function createRemoteHostWindows(
  core: CoreCaller,
  preloadPath: string,
  options: {
    /** Brings Settings → Connection → Connect to another PC to the front. */
    showConnectionSettings(): void;
  }
): RemoteHostWindows {
  const windows = new Map<string, BrowserWindow>();

  const saved = async (): Promise<RemoteHost[]> => (await core.call('remoteHosts/list', {})) as RemoteHost[];
  const savedHost = async (id: string): Promise<RemoteHost | undefined> => (await saved()).find((host) => host.id === id);
  const asDesktopHost = (host: RemoteHost): DesktopRemoteHost => ({ ...host, open: windows.has(host.id) });

  const snapshot = async (): Promise<DesktopRemoteHost[]> => {
    const hosts = await saved();
    // A relay that cannot answer leaves the hosts without a presence: state unknown.
    let online: Set<string> | null = null;
    if (hosts.length > 0) {
      const params: RemoteHostPresenceParams = { ids: hosts.map((host) => host.id) };
      online = await (core.call('remoteHosts/presence', params) as Promise<RemoteHostPresenceResult>).then(
        (result) => new Set(result.online),
        () => null
      );
    }
    return hosts.map((host) => ({
      ...asDesktopHost(host),
      ...(online ? { online: online.has(host.id) } : {}),
    }));
  };

  // The remote window's own PC switcher (top bar). Only a window this module
  // opened may ask, and it can only list names, open a SAVED host, or ask this
  // machine's main window to show its connection settings; it never learns a
  // host's route or credential.
  const hostWindowId = (sender: Electron.WebContents): string | null => {
    for (const [id, window] of windows) if (!window.isDestroyed() && window.webContents.id === sender.id) return id;
    return null;
  };
  ipcMain.handle(REMOTE_WINDOW_IPC.list, async (event): Promise<RemoteWindowHostEntry[]> => {
    const current = hostWindowId(event.sender);
    if (!current) return [];
    return (await snapshot()).map((host) => ({
      id: host.id,
      name: host.name,
      online: host.online ?? null,
      lastConnectedAt: host.lastConnectedAt,
      current: host.id === current,
    }));
  });
  ipcMain.handle(REMOTE_WINDOW_IPC.open, async (event, id) => {
    if (!hostWindowId(event.sender) || typeof id !== 'string') return false;
    const host = await savedHost(id);
    if (!host) return false;
    await openWindow(host);
    return true;
  });
  ipcMain.handle(REMOTE_WINDOW_IPC.manage, (event) => {
    if (!hostWindowId(event.sender)) return false;
    options.showConnectionSettings();
    return true;
  });

  const prepareSession = (partition: string) => {
    const ses = session.fromPartition(partition);
    ses.setUserAgent(remoteWindowUserAgent(ses.getUserAgent(), app.getName()));
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
    return ses;
  };

  const openWindow = async (host: RemoteHost, ticket?: string): Promise<void> => {
    const { id } = host;
    const existing = windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    const partition = remoteHostPartition(id);
    prepareSession(partition);
    const title = remoteWindowTitle(host.name);
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 640,
      minHeight: 480,
      title,
      // The same hidden title bar and native caption overlay as the main
      // window: the page draws its own band, so an OS frame title bar above it
      // stacked two title rows.
      ...DESKTOP_TITLEBAR_WINDOW_OPTIONS,
      webPreferences: {
        partition,
        preload: preloadPath,
        additionalArguments: [`${REMOTE_HOST_ARGUMENT}${encodeURIComponent(JSON.stringify({ id, name: host.name }))}`],
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    windows.set(id, window);
    notifyHostListsChanged();
    window.setMenuBarVisibility(false);
    // The page sets its own <title>; the window must keep saying which
    // computer it is driving.
    window.on('page-title-updated', (event) => event.preventDefault());
    window.on('closed', () => {
      if (windows.get(id) === window) windows.delete(id);
      notifyHostListsChanged();
    });
    const contents = window.webContents;
    // The page's theme-color is its window band (desktop-theme.ts): follow it
    // so the caption buttons keep contrast on a light-theme page.
    contents.on('did-change-theme-color', (_event, color) => {
      if (window.isDestroyed()) return;
      setWindowTitleBarBand(window, color?.toLowerCase() === DESKTOP_LIGHT_BACKGROUND_COLOR);
    });
    contents.setWindowOpenHandler(({ url }) => {
      const target = externalLinkTarget(url);
      if (target) void shell.openExternal(target);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isRemoteHostNavigation(host.url, url)) return;
      event.preventDefault();
      const target = externalLinkTarget(url);
      if (target) void shell.openExternal(target);
    });
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      // -3 is a navigation that was superseded, not a failure.
      if (!isMainFrame || code === -3 || window.isDestroyed()) return;
      const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
      const body = `<meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:${DESKTOP_BACKGROUND_COLOR};color:#e9e9e9;font:15px system-ui;-webkit-app-region:drag"><p>${escapeHtml(nativeT('Could not reach {{name}}. Close this window and connect again.').replace('{{name}}', () => host.name))}</p>`;
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`);
    });
    // The one-time ticket rides the fragment, which is never sent to the relay
    // with the page request; the page drops it once it has used it.
    await window.loadURL(ticket ? `${host.url}#pair=${ticket}` : host.url);
    // The list orders by this; a core that does not take it leaves the order as it was.
    const touch: ConnectionsIdParams = { id };
    await core.call('remoteHosts/touch', touch).catch(() => undefined);
  };

  return {
    list: snapshot,
    async connectByCode(rawCode) {
      const params: RemoteHostRedeemParams = { code: String(rawCode ?? '').trim() };
      const redeemed = (await core.call('remoteHosts/redeemCode', params)) as RedeemedHost;
      const { ticket, ...host } = redeemed;
      notifyHostListsChanged();
      // The fresh ticket has to reach a freshly loaded page, so an open window
      // for this host is replaced.
      const existing = windows.get(host.id);
      if (existing && !existing.isDestroyed()) existing.destroy();
      await openWindow(host, typeof ticket === 'string' && ticket ? ticket : undefined);
      return asDesktopHost(host);
    },
    async open(id) {
      const host = await savedHost(id);
      if (!host) throw new Error('This computer is not saved.');
      await openWindow(host);
      return snapshot();
    },
    async rename(id, name) {
      const params: ConnectionsRenameParams = { id, name };
      await core.call('remoteHosts/rename', params);
      notifyHostListsChanged();
    },
    async forget(id) {
      const window = windows.get(id);
      windows.delete(id);
      if (window && !window.isDestroyed()) window.destroy();
      const ses = session.fromPartition(remoteHostPartition(id));
      await ses.clearStorageData();
      await ses.clearCache();
      const params: ConnectionsIdParams = { id };
      await core.call('remoteHosts/forget', params);
      notifyHostListsChanged();
      return snapshot();
    },
  };
}

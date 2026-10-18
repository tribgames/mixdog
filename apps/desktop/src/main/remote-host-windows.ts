// The dedicated Electron window for "Connect to another PC": it loads the
// host's relay web app and runs the ordinary web pairing/claim flow in its own
// persistent session partition (one per host). It gets only the tiny
// remote-window preload — never the local desktop bridge — so the page installs
// the remote shim and every host action keeps going through the E2EE relay.
// Local conveniences (native file picker for attachments, OS notifications,
// links in the default browser) are this machine's own Chromium/Electron
// features and need no bridge into the host.
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';

import type { DesktopRemoteHost } from '../shared/contract';
import { nativeT } from './native-i18n';
import { REMOTE_HOST_ARGUMENT, REMOTE_WINDOW_IPC, type RemoteWindowHostEntry } from '../shared/remote-window';
import {
  externalLinkTarget,
  fetchHostPresence,
  isRemoteHostNavigation,
  parsePairCodeInput,
  parseRemoteHostLink,
  redeemPairCode,
  remoteHostPartition,
  remoteWindowTitle,
  remoteWindowUserAgent,
  toDesktopRemoteHost,
  type RemoteHostStore,
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

/** `preloadPath` comes from the main entry: this module is a lazily loaded
 *  chunk, so a path relative to its own directory would miss `out/preload`. */
export function createRemoteHostWindows(
  store: RemoteHostStore,
  preloadPath: string,
  options: {
    /** The relay's HTTP origin a code is redeemed at; null when relay is off. */
    relayOrigin(): string | null;
    /** Brings Settings → Connection → Connect to another PC to the front. */
    showConnectionSettings(): void;
  }
): RemoteHostWindows {
  const windows = new Map<string, BrowserWindow>();

  const snapshot = async (): Promise<DesktopRemoteHost[]> => {
    const hosts = store.list();
    const presence = await fetchHostPresence(hosts);
    return hosts.map((host) => ({
      ...toDesktopRemoteHost(host, windows.has(host.id)),
      ...(presence.has(host.id) ? { online: presence.get(host.id) } : {}),
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
    if (!hostWindowId(event.sender) || typeof id !== 'string' || !store.get(id)) return false;
    await openWindow(id);
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

  const openWindow = async (id: string, ticket?: string): Promise<void> => {
    const host = store.get(id);
    if (!host) throw new Error('This computer is not saved.');
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
    window.setMenuBarVisibility(false);
    // The page sets its own <title>; the window must keep saying which
    // computer it is driving.
    window.on('page-title-updated', (event) => event.preventDefault());
    window.on('closed', () => {
      if (windows.get(id) === window) windows.delete(id);
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
    await store.touch(id);
  };

  return {
    list: snapshot,
    async connectByCode(rawCode) {
      const code = parsePairCodeInput(rawCode);
      if (!code) throw new TypeError(nativeT('Enter the 6-digit code shown on your PC.'));
      const relayOrigin = options.relayOrigin();
      if (!relayOrigin) throw new Error('Remote access is turned off on this PC.');
      const redeemed = await redeemPairCode(relayOrigin, code, undefined, nativeT);
      const parsed = parseRemoteHostLink(`${relayOrigin}/d/${redeemed.deviceId}/`);
      if (!parsed) throw new Error(nativeT('Codes are not available on this connection server yet. Use the QR code.'));
      const saved = await store.save(parsed, redeemed.name);
      // The fresh ticket has to reach a freshly loaded page, so an open window
      // for this host is replaced.
      const existing = windows.get(saved.id);
      if (existing && !existing.isDestroyed()) existing.destroy();
      await openWindow(saved.id, redeemed.ticket);
      return toDesktopRemoteHost(saved, true);
    },
    async open(id) {
      await openWindow(id);
      return snapshot();
    },
    async rename(id, name) {
      await store.rename(id, name);
    },
    async forget(id) {
      const window = windows.get(id);
      windows.delete(id);
      if (window && !window.isDestroyed()) window.destroy();
      const ses = session.fromPartition(remoteHostPartition(id));
      await ses.clearStorageData();
      await ses.clearCache();
      await store.remove(id);
      return snapshot();
    },
  };
}

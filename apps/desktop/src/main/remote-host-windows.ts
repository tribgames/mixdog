// The dedicated Electron window for "Connect to another PC": it loads the
// host's relay web app and runs the ordinary web pairing/claim flow in its own
// persistent session partition (one per host). It gets only the tiny
// remote-window preload — never the local desktop bridge — so the page installs
// the remote shim and every host action keeps going through the E2EE relay.
// Local conveniences (native file picker for attachments, OS notifications,
// links in the default browser) are this machine's own Chromium/Electron
// features and need no bridge into the host.
import { app, BrowserWindow, session, shell } from 'electron';

import type { DesktopRemoteHost } from '../shared/contract';
import { REMOTE_HOST_ARGUMENT } from '../shared/remote-window';
import {
  externalLinkTarget,
  isRemoteHostNavigation,
  parseRemoteHostLink,
  remoteHostPartition,
  remoteWindowTitle,
  remoteWindowUserAgent,
  toDesktopRemoteHost,
  type RemoteHostStore,
} from './remote-hosts';

const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

export interface RemoteHostWindows {
  list(): Promise<DesktopRemoteHost[]>;
  connect(link: string, name?: string): Promise<DesktopRemoteHost>;
  open(id: string): Promise<DesktopRemoteHost[]>;
  forget(id: string): Promise<DesktopRemoteHost[]>;
}

/** `preloadPath` comes from the main entry: this module is a lazily loaded
 *  chunk, so a path relative to its own directory would miss `out/preload`. */
export function createRemoteHostWindows(store: RemoteHostStore, preloadPath: string): RemoteHostWindows {
  const windows = new Map<string, BrowserWindow>();

  const snapshot = (): DesktopRemoteHost[] =>
    store.list().map((host) => toDesktopRemoteHost(host, windows.has(host.id)));

  const prepareSession = (partition: string) => {
    const ses = session.fromPartition(partition);
    ses.setUserAgent(remoteWindowUserAgent(ses.getUserAgent(), app.getName()));
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
    return ses;
  };

  const openWindow = async (id: string): Promise<void> => {
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
      backgroundColor: '#0e0e0e',
      autoHideMenuBar: true,
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
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is a navigation that was superseded, not a failure.
      if (!isMainFrame || code === -3 || window.isDestroyed()) return;
      const escape = (text: string): string =>
        text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
      const body = `<meta charset="utf-8"><title>${escape(title)}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0e0e0e;color:#e9e9e9;font:15px system-ui"><p>Could not reach ${escape(host.name)}: ${escape(description)}. Close this window and connect again.</p>`;
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`);
    });
    await window.loadURL(host.url);
    await store.touch(id);
  };

  return {
    list: async () => snapshot(),
    async connect(link, name) {
      const parsed = parseRemoteHostLink(link);
      if (!parsed) throw new TypeError('That is not a Mixdog pairing link.');
      const saved = await store.save(parsed, typeof name === 'string' ? name : '');
      await openWindow(saved.id);
      return toDesktopRemoteHost(saved, true);
    },
    async open(id) {
      await openWindow(id);
      return snapshot();
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

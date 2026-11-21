import { app, ipcMain, type Session, session, type WebContents, type WebFrameMain } from 'electron';

import { rememberBrowserIdentity } from './browser-identity';
import { BROWSER_PARTITION } from './host-types';
import { createBrowserDownloadLedger } from './downloads';
import { installBrowserPageZoom } from './page-zoom';
import { type BrowserPermissionPolicyStore, createBrowserPermissions } from './permissions';
import { redactBrowserText } from './redaction';
import { browserRequestDisposition } from './request-scheme';
import { browserAcceptLanguages, browserPartitionUserAgent } from './user-agent';

/** The app's own agent string (Electron and the app name in it), read once,
 *  before the fallback names Chrome. */
let appUserAgent: string | undefined;
/** The browser partition's session, the one session that presents Chrome. */
let browserSession: Session | undefined;

function keepAppUserAgent(owned: Session): void {
  if (owned !== browserSession) owned.setUserAgent(appUserAgent as string);
}

interface BrowserPartitionHost {
  /** The session of the app window that hosts the browser; it keeps the app's
   *  own agent string. */
  windowSession: Session;
  /** Policy check for a page-generated request, DNS answer included. */
  assertResolvedResourceUrlAllowed(url: string): Promise<void>;
  downloadsDirectory(): string;
  sessionIdForGuest(guest: WebContents): string | undefined;
  defaultSessionId: string;
  /** Called before a refused request is cancelled, so the page's failure
   *  record can say which rule refused it; Chromium reports only a code. */
  onRequestRefused?(webContentsId: number | undefined, url: string, reason: string): void;
  /** A page's main-frame POST navigation with its body (linked sign-in's
   *  form_post callbacks); read in memory, never kept here. */
  onNavigationPost?(webContentsId: number, url: string, chunks: Buffer[]): void;
  /** The `browserHidDevices` setting: sites may ask to connect a HID device. */
  hidDevices?(): boolean;
  /** The saved site-permission defaults and exceptions. */
  permissionPolicy?: BrowserPermissionPolicyStore;
  /** The page a frame asking for a device belongs to. */
  guestForFrame?(frame: WebFrameMain): WebContents | null | undefined;
}

export function createBrowserPartition(host: BrowserPartitionHost) {
  const partitionSession: Session = session.fromPartition(BROWSER_PARTITION);
  // A site gets a permission only as the saved settings or a person's answer in the pane say.
  const permissions = createBrowserPermissions({
    hidDevices: host.hidDevices,
    guestForFrame: host.guestForFrame,
    policy: host.permissionPolicy?.policy,
    save: host.permissionPolicy?.save,
  });
  permissions.install(partitionSession);
  // The session's user agent does not reach workers or out-of-process frames, so the
  // process-wide fallback carries it too; Turnstile refuses a mixed identity.
  if (appUserAgent === undefined) {
    appUserAgent = app.userAgentFallback;
    app.on('session-created', keepAppUserAgent);
  }
  browserSession = partitionSession;
  const userAgent = browserPartitionUserAgent(appUserAgent);
  const acceptLanguages =
    browserAcceptLanguages([app.getSystemLocale(), ...app.getPreferredSystemLanguages()]) || undefined;
  app.userAgentFallback = userAgent;
  partitionSession.setUserAgent(userAgent, acceptLanguages);
  rememberBrowserIdentity({ userAgent });
  keepAppUserAgent(session.defaultSession);
  keepAppUserAgent(host.windowSession);
  partitionSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame' && details.method === 'POST' && details.webContentsId !== undefined) {
      const chunks = (details.uploadData ?? []).flatMap((part) => (part.bytes ? [part.bytes] : []));
      host.onNavigationPost?.(details.webContentsId, details.url, chunks);
    }
    const disposition = browserRequestDisposition(details.url, details.resourceType);
    if (disposition !== 'web') {
      callback({ cancel: disposition === 'deny' });
      return;
    }
    void host.assertResolvedResourceUrlAllowed(details.url).then(
      () => callback({}),
      (error) => {
        const reason = redactBrowserText((error as Error).message);
        console.warn('Browser Use blocked request:', reason);
        host.onRequestRefused?.(details.webContentsId, details.url, reason);
        callback({ cancel: true });
      }
    );
  });
  // Downloads auto-save into the user's Downloads folder (no dialog); the
  // ledger is what the agent sees.
  const downloadLedger = createBrowserDownloadLedger({
    downloadsDirectory: host.downloadsDirectory,
    sessionIdForGuest: host.sessionIdForGuest,
    defaultSessionId: host.defaultSessionId,
  });
  partitionSession.on('will-download', downloadLedger.onWillDownload);
  const uninstallPageZoom = installBrowserPageZoom(ipcMain, partitionSession);

  return {
    session: partitionSession,
    downloadLedger,
    permissions,
    dispose(): void {
      uninstallPageZoom();
      partitionSession.removeListener('will-download', downloadLedger.onWillDownload);
      permissions.uninstall(partitionSession);
      partitionSession.webRequest.onBeforeRequest(null);
    },
  };
}

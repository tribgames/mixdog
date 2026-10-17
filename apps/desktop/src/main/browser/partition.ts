/**
 * The persistent partition every Browser Use page shares — visible pane tabs
 * and hidden background pages alike — so the agent stays logged in across
 * both. Three session-wide guards live here: a site holds a permission only
 * when a person granted it in the pane, every request passes the URL policy (including its resolved
 * address), and downloads land in the user's folder through a ledger the
 * `downloads` action can report.
 */
import type { Session, WebContents } from 'electron';
import { app, session } from 'electron';

import { rememberBrowserIdentity } from './browser-identity';
import { BROWSER_PARTITION } from './command';
import { createBrowserDownloadLedger } from './downloads';
import { clearBrowserPermissionHandlers, createBrowserPermissions } from './permissions';
import { redactBrowserText } from './redaction';
import { browserRequestDisposition } from './request-scheme';
import { browserAcceptLanguages, browserBrandRequestHeaders, browserPartitionUserAgent } from './user-agent';

interface BrowserPartitionHost {
  /** Policy check for a page-generated request, DNS answer included. */
  assertResolvedResourceUrlAllowed(url: string): Promise<void>;
  downloadsDirectory(): string;
  sessionIdForGuest(guest: WebContents): string | undefined;
  defaultSessionId: string;
  /** Called before a refused request is cancelled, so the page's failure
   *  record can say which rule refused it; Chromium reports only a code. */
  onRequestRefused?(webContentsId: number | undefined, url: string, reason: string): void;
}

export function createBrowserPartition(host: BrowserPartitionHost) {
  const partitionSession: Session = session.fromPartition(BROWSER_PARTITION);
  // A site gets a permission only from a person's answer in the pane.
  const permissions = createBrowserPermissions();
  permissions.install(partitionSession);
  // Pages see the Chrome build that renders them, with the language list a
  // Chrome profile seeds from the system's own languages.
  const userAgent = browserPartitionUserAgent(partitionSession.getUserAgent());
  const acceptLanguages =
    browserAcceptLanguages([app.getSystemLocale(), ...app.getPreferredSystemLanguages()]) || undefined;
  partitionSession.setUserAgent(userAgent, acceptLanguages);
  rememberBrowserIdentity({ userAgent, acceptLanguages });
  // Requests no page override covers (a service worker's, for one) leave
  // with the engine's own agent string and brand list; both are rewritten
  // here so every request of the partition names the same browser.
  partitionSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = browserBrandRequestHeaders(details.requestHeaders, process.versions.chrome);
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'user-agent' && /\b(?:Electron|mixdog[\w-]*)\//i.test(headers[name])) {
        headers[name] = browserPartitionUserAgent(headers[name]);
      }
    }
    callback({ requestHeaders: headers });
  });
  partitionSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
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

  return {
    session: partitionSession,
    downloadLedger,
    permissions,
    dispose(): void {
      partitionSession.removeListener('will-download', downloadLedger.onWillDownload);
      clearBrowserPermissionHandlers(partitionSession);
      partitionSession.webRequest.onBeforeRequest(null);
      partitionSession.webRequest.onBeforeSendHeaders(null);
    },
  };
}

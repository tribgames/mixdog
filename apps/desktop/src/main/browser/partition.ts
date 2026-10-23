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
import { browserAcceptLanguages, browserPartitionUserAgent } from './user-agent';

/** The app's own agent string (Electron and the app name in it), read once,
 *  before the fallback names Chrome. */
let appUserAgent: string | undefined;
/** The browser partition's session, the one session that presents Chrome. */
let browserSession: Session | undefined;

/** Gives an app-owned session the app's own agent string. Installed on
 *  `session-created` once per process and never removed: the fallback stays
 *  Chrome for the rest of the process, so a session created after a host is
 *  disposed (a window opened later) must still keep Electron. */
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
}

export function createBrowserPartition(host: BrowserPartitionHost) {
  const partitionSession: Session = session.fromPartition(BROWSER_PARTITION);
  // A site gets a permission only from a person's answer in the pane.
  const permissions = createBrowserPermissions();
  permissions.install(partitionSession);
  // Pages see the Chrome build that renders them, with the language list a
  // Chrome profile seeds from the system's own languages. The string is the
  // process-wide fallback too, so workers, service workers and out-of-process
  // frames (which the session's string does not reach) send the same one;
  // the brands stay the engine's own, and no request is rewritten. A site
  // compares all of these, and Turnstile refuses a mixed identity.
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
  // Every other session of the app keeps the app's own agent string: the
  // shell detects Electron by it. The default session and the window's own
  // exist already; a session created later (a snapshot, an export, a remote
  // window's) is covered when it appears.
  keepAppUserAgent(session.defaultSession);
  keepAppUserAgent(host.windowSession);
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
    },
  };
}

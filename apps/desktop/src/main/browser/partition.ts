/**
 * The persistent partition every Browser Use page shares — visible pane tabs
 * and hidden background pages alike — so the agent stays logged in across
 * both. Three session-wide guards live here: agent pages get no ambient
 * permission, every request passes the URL policy (including its resolved
 * address), and downloads land in the user's folder through a ledger the
 * `downloads` action can report.
 */
import type { Session, WebContents } from 'electron';
import { session } from 'electron';

import { BROWSER_PARTITION } from './command';
import { clearBrowserData, type BrowserDataClearResult, type BrowserDataScope } from './browsing-data';
import { createBrowserDownloadLedger } from './downloads';
import { clearBrowserPermissionHandlers, lockDownBrowserPermissions } from './permissions';
import { redactBrowserText } from './redaction';
import { browserPartitionUserAgent } from './user-agent';

export interface BrowserPartitionHost {
  /** Policy check for a page-generated request, DNS answer included. */
  assertResolvedResourceUrlAllowed(url: string): Promise<void>;
  downloadsDirectory(): string;
  sessionIdForGuest(guest: WebContents): string | undefined;
  defaultSessionId: string;
  /** Called before a refused request is cancelled, so the page's failure
   *  record can say which rule refused it; Chromium reports only a code. */
  onRequestRefused?(webContentsId: number | undefined, url: string, reason: string): void;
}

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const EMBEDDED_ONLY_PROTOCOLS = new Set(['about:', 'data:', 'blob:']);

export function createBrowserPartition(host: BrowserPartitionHost) {
  const partitionSession: Session = session.fromPartition(BROWSER_PARTITION);
  // Agent-visited pages receive no ambient browser permission. A future
  // capability-specific approval path can grant an individual request.
  lockDownBrowserPermissions(partitionSession);
  partitionSession.setUserAgent(browserPartitionUserAgent(partitionSession.getUserAgent()));
  partitionSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let parsed: URL;
    try {
      parsed = new URL(details.url);
    } catch {
      callback({ cancel: true });
      return;
    }
    if (!WEB_PROTOCOLS.has(parsed.protocol)) {
      const allowedEmbedded = details.resourceType !== 'mainFrame' && EMBEDDED_ONLY_PROTOCOLS.has(parsed.protocol);
      callback({ cancel: !allowedEmbedded });
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
    /** Every Browser Use page shares this partition, so clearing it is the
     * only way a person can reclaim the disk it accumulated. */
    clearBrowsingData(
      scopes: readonly BrowserDataScope[],
      options?: { persistCookieState?: () => Promise<void> }
    ): Promise<BrowserDataClearResult> {
      return clearBrowserData(partitionSession, scopes, options);
    },
    dispose(): void {
      partitionSession.removeListener('will-download', downloadLedger.onWillDownload);
      clearBrowserPermissionHandlers(partitionSession);
      partitionSession.webRequest.onBeforeRequest(null);
    },
  };
}

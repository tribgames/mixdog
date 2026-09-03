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
import { createBrowserDownloadLedger } from './downloads';
import {
  clearBrowserPermissionHandlers,
  lockDownBrowserPermissions,
} from './permissions';
import { redactBrowserText } from './redaction';

export interface BrowserPartitionHost {
  /** Policy check for a page-generated request, DNS answer included. */
  assertResolvedResourceUrlAllowed(url: string): Promise<void>;
  downloadsDirectory(): string;
  sessionIdForGuest(guest: WebContents): string | undefined;
  defaultSessionId: string;
}

const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const EMBEDDED_ONLY_PROTOCOLS = new Set(['about:', 'data:', 'blob:']);

export function createBrowserPartition(host: BrowserPartitionHost) {
  const partitionSession: Session = session.fromPartition(BROWSER_PARTITION);
  // Agent-visited pages receive no ambient browser permission. A future
  // capability-specific approval path can grant an individual request.
  lockDownBrowserPermissions(partitionSession);
  partitionSession.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      let parsed: URL;
      try {
        parsed = new URL(details.url);
      } catch {
        callback({ cancel: true });
        return;
      }
      if (!WEB_PROTOCOLS.has(parsed.protocol)) {
        const allowedEmbedded = details.resourceType !== 'mainFrame'
          && EMBEDDED_ONLY_PROTOCOLS.has(parsed.protocol);
        callback({ cancel: !allowedEmbedded });
        return;
      }
      void host.assertResolvedResourceUrlAllowed(details.url).then(
        () => callback({}),
        (error) => {
          console.warn('Browser Use blocked request:', redactBrowserText((error as Error).message));
          callback({ cancel: true });
        },
      );
    },
  );
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
    dispose(): void {
      partitionSession.removeListener('will-download', downloadLedger.onWillDownload);
      clearBrowserPermissionHandlers(partitionSession);
      partitionSession.webRequest.onBeforeRequest(null);
    },
  };
}

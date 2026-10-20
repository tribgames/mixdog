/**
 * The browser host's profile-import surface: importable sources, the import
 * itself with its progress, history search, stored credentials, and the
 * signed-in sites with their sign-out.
 */
import type { DesktopBrowserImportProgress } from '../../shared/contract';
import { DESKTOP_IPC } from '../../shared/contract';
import type { BrowserCredentialFillResult, createBrowserCredentialFill } from './credential-autofill';
import type {
  BrowserCredentialSuggestion,
  BrowserHistoryEntry,
  BrowserImportRequest,
  BrowserImportResult,
  BrowserImportSource,
  BrowserProfileImportService,
} from './profile-import';
import { type BrowserSessionRegistry, browserSessionId } from './session-registry';
import type { BrowserSignedInSite, createBrowserSignIns } from './signed-in-sites';

export function createBrowserProfileHostMethods(options: {
  profileImporter: BrowserProfileImportService;
  signIns: ReturnType<typeof createBrowserSignIns>;
  liveGuest: BrowserSessionRegistry['liveGuest'];
  fillCredentialInGuest: ReturnType<typeof createBrowserCredentialFill>['fillCredentialInGuest'];
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  publishRemoteImportProgress?: (progress: DesktopBrowserImportProgress) => Promise<void>;
}) {
  const { profileImporter } = options;
  return {
    async browserImportSources(): Promise<BrowserImportSource[]> {
      return await profileImporter.sources();
    },
    async browserImport(request: BrowserImportRequest): Promise<BrowserImportResult> {
      return await profileImporter.importProfile(request, (progress) => {
        options.sendToRenderer(DESKTOP_IPC.browserProfileImportProgress, progress);
        void options.publishRemoteImportProgress?.(progress)?.catch(() => undefined);
      });
    },
    browserSignedInSites: (): Promise<BrowserSignedInSite[]> => options.signIns.list(),
    browserSignOutSite: (site: string): Promise<number> => options.signIns.signOut(site),
    browserClearSignIns: (): Promise<void> => options.signIns.clearAll(),
    async browserHistorySearch(query: string): Promise<BrowserHistoryEntry[]> {
      return await profileImporter.searchHistory(query);
    },
    async browserCredentialSuggestions(sessionId: string): Promise<BrowserCredentialSuggestion[]> {
      const guest = options.liveGuest(browserSessionId(sessionId));
      if (!guest) return [];
      return await profileImporter.credentialSuggestions(guest.getURL());
    },
    async browserCredentialFill(sessionId: string, credentialId: string): Promise<BrowserCredentialFillResult> {
      const guest = options.liveGuest(browserSessionId(sessionId));
      if (!guest) throw new Error('Open a Browser Use page before filling a stored credential.');
      return await profileImporter.useCredential(guest.getURL(), credentialId, (credential) =>
        options.fillCredentialInGuest(guest, credential)
      );
    },
  };
}

/**
 * The browser host's profile-import surface: importable sources, the import
 * itself with its progress, history search, stored credentials, and the
 * signed-in sites with their sign-out.
 */
import type { DesktopBrowserImportProgress } from '../../shared/contract';
import { DESKTOP_IPC } from '../../shared/contract';
import type { BrowserCredentialFillResult, createBrowserCredentialFill } from './credential-autofill';
import type { CredentialVault, VaultLoginSummary } from './credential-vault';
import type { LinkedSignIn } from './linked-sign-in';
import type { LinkedSignInStore } from './linked-sign-in-store';
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
  vault: Pick<CredentialVault, 'list' | 'saveManual' | 'remove' | 'mergeImport'>;
  /** The remembered "Continue with Google/GitHub" sign-ins (linked-sign-in-store.ts). */
  linkedSignIns: Pick<LinkedSignInStore, 'list' | 'remove' | 'clear'>;
  liveGuest: BrowserSessionRegistry['liveGuest'];
  fillCredentialInGuest: ReturnType<typeof createBrowserCredentialFill>['fillCredentialInGuest'];
  /** A login takeover's saved-login fill into the page it was bound to
   *  (host-agent.ts fillBoundLogin). */
  fillBoundLogin: (sessionId: string, fillId: string, credentialId: string) => Promise<BrowserCredentialFillResult>;
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  publishRemoteImportProgress?: (progress: DesktopBrowserImportProgress) => Promise<void>;
}) {
  const { profileImporter, vault } = options;
  return {
    /** The saved logins, no passwords or authenticator keys (설정 › 인증 관리). */
    browserVaultLogins: (): Promise<VaultLoginSummary[]> => vault.list(),
    /** Add (no id) or edit (id) a saved login; secrets flow in only. */
    browserVaultSave: (input: {
      id?: string;
      origin: string;
      username: string;
      password?: string;
      totpSecret?: string;
      note?: string;
    }): Promise<void> => vault.saveManual(input),
    browserVaultDelete: (id: string): Promise<boolean> => vault.remove(id),
    /** Which identity provider (and account, when known) each site was last signed in with. */
    browserLinkedSignIns: (): Promise<LinkedSignIn[]> => options.linkedSignIns.list(),
    browserLinkedSignInDelete: (id: string): Promise<boolean> => options.linkedSignIns.remove(id),
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
    /** Every sign-in goes, the remembered linked ones with it. */
    async browserClearSignIns(): Promise<void> {
      await options.signIns.clearAll();
      await options.linkedSignIns.clear();
    },
    async browserHistorySearch(query: string): Promise<BrowserHistoryEntry[]> {
      return await profileImporter.searchHistory(query);
    },
    async browserCredentialSuggestions(sessionId: string): Promise<BrowserCredentialSuggestion[]> {
      const guest = options.liveGuest(browserSessionId(sessionId));
      if (!guest) return [];
      return await profileImporter.credentialSuggestions(guest.getURL());
    },
    /** Fill a stored login into the session's page; with `fillId` (a login
     *  takeover's card), into the page that takeover was bound to instead.
     *  Either way the fill is held to the address checked before the vault
     *  is read: a navigation meanwhile sends nothing to the new page. */
    async browserCredentialFill(
      sessionId: string,
      credentialId: string,
      fillId?: string
    ): Promise<BrowserCredentialFillResult> {
      if (fillId) return await options.fillBoundLogin(sessionId, fillId, credentialId);
      const guest = options.liveGuest(browserSessionId(sessionId));
      if (!guest) throw new Error('Open a Browser Use page before filling a stored credential.');
      const url = guest.getURL();
      return await profileImporter.useCredential(url, credentialId, (credential) =>
        options.fillCredentialInGuest(guest, credential, undefined, url)
      );
    },
  };
}

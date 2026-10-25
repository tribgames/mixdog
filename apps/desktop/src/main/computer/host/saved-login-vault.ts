/**
 * The vault half of Computer Use saved logins (saved-login.ts), through
 * Browser Use's own API over the same sealed file: an account resolves the
 * way the browser's `fill savedAccount` resolves it (profile-import.ts
 * useCredentialByAccount: the exact username or its masked label, for the
 * page's origin only, a miss naming the stored masked labels).
 */
import { app, session } from 'electron';
import { maskedCredentialLabel, secureOrigin } from '../../browser/credential-vault';
import { BrowserProfileImportService } from '../../browser/profile-import';
import type { SavedLoginField, SavedLoginValue, SavedLoginVault } from './saved-login';

export function createSavedLoginVault(): SavedLoginVault {
  // Only the stored-login reads are used; the import half (its partition) never runs.
  let importer: BrowserProfileImportService | undefined;
  const logins = () =>
    (importer ??= new BrowserProfileImportService({
      userDataDirectory: app.getPath('userData'),
      temporaryDirectory: app.getPath('temp'),
      partition: session.defaultSession,
    }));
  return {
    async value(url: string, account: string, field: SavedLoginField): Promise<SavedLoginValue> {
      const login = await logins().useCredentialByAccount(url, account, async (credential) => ({
        username: credential.username,
        password: field === 'password' ? credential.password : '',
      }));
      const origin = secureOrigin(url);
      const label = maskedCredentialLabel(login.username);
      return { value: field === 'password' ? login.password : login.username, label, origin };
    },
  };
}

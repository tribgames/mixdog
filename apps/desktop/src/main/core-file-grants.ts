// One-file access grants held by the core. The window's main process validates what it is given, asks the core to
// describe (and, for a picked or dropped file, mint a token for) paths and to redeem a token for the one file it names;
// a refusal the core names by a denial code reaches the page and the file IPCs as the LocalAccessDeniedError they
// already recognise (isLocalAccessDenied), the same as when the grants lived here.
import type { DesktopLocalPathEntry } from '../shared/contract';
import { requiredString } from './ipc-validation';
import { isLocalAccessDenied, LocalAccessDeniedError } from './local-access-denied';

export interface CoreFileGrants {
  /** `grant: false` describes a chat link's path: a file outside every Project is addressed as its own folder's file
   *  with no token, so nothing is granted. The picker and drop keep their one-off grants. */
  describe(paths: unknown, grant?: boolean): Promise<DesktopLocalPathEntry[]>;
  requireGrant(accessToken: unknown, projectPath: unknown, relPath: unknown): Promise<{ root: string; rel: string; absolute: string }>;
}

type Invoke = <T>(name: string, args: unknown[]) => Promise<T>;

export function createCoreFileGrants(invoke: Invoke): CoreFileGrants {
  // A denial the core reports by code becomes the error the callers test for; anything else is left as it came.
  const call = async <T>(name: string, args: unknown[]): Promise<T> => {
    try {
      return await invoke<T>(name, args);
    } catch (error) {
      if (error instanceof LocalAccessDeniedError || !isLocalAccessDenied(error)) throw error;
      const { code, message } = error as { code: string; message?: unknown };
      throw new LocalAccessDeniedError(typeof message === 'string' ? message : code, code);
    }
  };
  return {
    describe(paths, grant = true) {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
        return Promise.reject(new TypeError('paths are invalid.'));
      }
      return call<DesktopLocalPathEntry[]>('grantDescribe', [paths, grant !== false]);
    },
    async requireGrant(accessToken, projectPath, relPath) {
      const token = requiredString(accessToken, 'file access token', 128);
      return call('grantRedeem', [token, requiredString(projectPath, 'projectPath'), requiredString(relPath, 'relPath')]);
    },
  };
}

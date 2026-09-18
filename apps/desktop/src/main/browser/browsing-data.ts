import type { Session } from 'electron';

import { redactBrowserText } from './redaction';

/** Three separate decisions, not one "clear everything" button. Cache costs a
 * page nothing but a slower reload; site data drops what a page saved locally;
 * cookies end the sessions the user is signed in to. Each is cleared on its
 * own so one failure never hides the rest. */
export type BrowserDataScope = 'cache' | 'siteData' | 'cookies';

export interface BrowserDataClearResult {
  cleared: BrowserDataScope[];
  errors: Partial<Record<BrowserDataScope, string>>;
}

type BrowserDataSession = Pick<Session, 'clearCache' | 'clearCodeCaches' | 'clearStorageData'>;

/** Everything a site stored locally, minus the cookies that hold its login. */
const SITE_DATA_STORAGES = [
  'cachestorage',
  'filesystem',
  'indexdb',
  'localstorage',
  'serviceworkers',
  'shadercache',
  'websql',
] as const;

export async function clearBrowserData(
  session: BrowserDataSession,
  scopes: readonly BrowserDataScope[],
  options: {
    /** Session cookies also live in the host's own sealed file, so clearing
     *  Chromium's copy alone would let the next restore sign the user back in.
     *  Rewriting that file is part of clearing cookies, not a follow-up. */
    persistCookieState?: () => Promise<void>;
  } = {}
): Promise<BrowserDataClearResult> {
  const result: BrowserDataClearResult = { cleared: [], errors: {} };
  for (const scope of new Set(scopes)) {
    try {
      if (scope === 'cache') {
        await session.clearCache();
        // Compiled script caches survive clearCache and keep occupying disk.
        await session.clearCodeCaches({ urls: [] });
      } else {
        await session.clearStorageData({
          storages: scope === 'cookies' ? ['cookies'] : [...SITE_DATA_STORAGES],
        });
        if (scope === 'cookies') await options.persistCookieState?.();
      }
      result.cleared.push(scope);
    } catch (error) {
      result.errors[scope] = redactBrowserText(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}

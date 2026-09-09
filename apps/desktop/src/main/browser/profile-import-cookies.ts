import {
  cookiePartitionKey,
  isBrowserInternalCookiePartition,
  storedCookieSetDetails,
  type BrowserCookie,
  type BrowserCookieJar,
} from './cookie-jar';

export interface BrowserImportCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  session?: unknown;
  sameSite?: unknown;
  partitionKey?: unknown;
}

export interface NativeCookieImportFailures {
  decryption: number;
  domainMismatch: number;
  invalidEncoding: number;
  invalidPartition: number;
}

export interface NativeCookieImportReport {
  version: 2;
  sourceCount: number;
  expired: number;
  cookies: BrowserImportCookie[];
  failures: NativeCookieImportFailures;
}

const FAILURE_KEYS = [
  'decryption', 'domainMismatch', 'invalidEncoding', 'invalidPartition',
] as const;
const MAX_COOKIES = 1_000_000;

/** Require source accounting: an old array-only helper cannot prove completeness. */
export function parseBrowserCookieReport(output: unknown): NativeCookieImportReport {
  if (Array.isArray(output)) {
    throw new Error('The native cookie importer must be updated; its report cannot account for skipped cookies.');
  }
  if (!output || typeof output !== 'object') {
    throw new Error('Native cookie importer returned an invalid report.');
  }
  const report = output as Partial<NativeCookieImportReport>;
  const count = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COOKIES;
  if (report.version !== 2 || !count(report.sourceCount) || !count(report.expired)
    || !Array.isArray(report.cookies) || report.cookies.length > MAX_COOKIES
    || !report.failures || typeof report.failures !== 'object'
    || !FAILURE_KEYS.every((key) => count(report.failures?.[key]))
    || report.cookies.some((cookie) => !cookie || typeof cookie !== 'object' || Array.isArray(cookie))) {
    throw new Error('Native cookie importer returned an invalid report.');
  }
  const failed = FAILURE_KEYS.reduce((sum, key) => sum + report.failures![key], 0);
  if (report.sourceCount !== report.cookies.length + failed + report.expired) {
    throw new Error('Native cookie importer returned inconsistent source counts.');
  }
  return report as NativeCookieImportReport;
}

export class CookieImportError extends Error {
  constructor(
    readonly imported: number,
    readonly failed: number,
    sourceFailures?: NativeCookieImportFailures,
  ) {
    const detail = sourceFailures
      ? ` Source failures: ${sourceFailures.decryption} decryption, ${sourceFailures.domainMismatch} domain integrity,`
        + ` ${sourceFailures.invalidEncoding} invalid encoding, ${sourceFailures.invalidPartition} invalid partition.`
      : '';
    super(`Cookie import incomplete: ${imported} imported, ${failed} failed.${detail} Existing cookies were not cleared. Sign-in has not been verified.`);
  }
}

function sameSite(value: unknown): Electron.CookiesSetDetails['sameSite'] {
  switch (String(value || '').toLowerCase()) {
    case 'strict': return 'strict';
    case 'lax': return 'lax';
    case 'none':
    case 'no_restriction': return 'no_restriction';
    default: return 'unspecified';
  }
}

function cookieKey(cookie: { domain?: unknown; name?: unknown; path?: unknown; partitionKey?: unknown }): string {
  const key = cookie.partitionKey as BrowserCookie['partitionKey'];
  return JSON.stringify([cookie.domain, cookie.name, cookie.path || '/', key?.topLevelSite, key?.hasCrossSiteAncestor]);
}

/** Preserve host-only identity, including Chromium's mandatory __Host- rules. */
export async function importBrowserCookies(
  partition: { cookies: BrowserCookieJar },
  cookies: BrowserImportCookie[],
  backup: (cookies: BrowserCookie[]) => Promise<void>,
  sourceFailures?: NativeCookieImportFailures,
): Promise<number> {
  const existing = await partition.cookies.get({});
  // Persist an OS-encrypted recovery snapshot before any changes.
  await backup(existing);
  const existingKeys = new Set(existing.map(cookieKey));
  const sourceKeys = new Set(cookies.map(cookieKey));
  let imported = 0;
  let failed = sourceFailures
    ? FAILURE_KEYS.reduce((sum, key) => sum + sourceFailures[key], 0)
    : 0;
  for (const cookie of cookies) {
    const name = typeof cookie.name === 'string' ? cookie.name : '';
    const domain = typeof cookie.domain === 'string' ? cookie.domain : '';
    const host = domain.replace(/^\./, '');
    const path = typeof cookie.path === 'string' ? cookie.path : '/';
    if (!name || typeof cookie.value !== 'string' || !/^[a-z0-9.-]+$/i.test(host)
      || !path.startsWith('/')) {
      failed += 1;
      continue;
    }
    const isSession = cookie.session === true
      || (cookie.session === undefined && cookie.expires === undefined);
    const expirationDate = cookie.expires;
    if (!isSession && (typeof expirationDate !== 'number' || !Number.isFinite(expirationDate))) {
      failed += 1;
      continue;
    }
    // Expired cookies cannot authenticate and must not become session cookies.
    if (!isSession && (expirationDate as number) <= Date.now() / 1000) continue;
    const secure = cookie.secure === true;
    // Import is a privileged local operation, not an HTTP response. Use a
    // trustworthy registration URL even for non-Secure cookies; otherwise
    // Chromium refuses valid overlapping Secure/non-Secure source cookies.
    // The cookie's own Secure attribute remains unchanged.
    const url = `https://${host}${path}`;
    try {
      // These cookies belong to Chrome's own UI, not to a web browsing
      // context in this app. Exclude normally without widening their scope.
      if (isBrowserInternalCookiePartition(cookie.partitionKey)) continue;
      const partitionKey = cookiePartitionKey(cookie.partitionKey);
      if (partitionKey && partition.cookies.supportsPartitions !== true) {
        throw new Error('The destination does not support partitioned cookies.');
      }
      if (!domain.startsWith('.')) {
        const wrongDomainKey = cookieKey({ domain: `.${host}`, name, path, partitionKey });
        if (!sourceKeys.has(wrongDomainKey)
          && existingKeys.has(wrongDomainKey)) {
          // The old importer widened host-only cookies to .host. Electron's
          // URL/name removal can also remove other matching paths or parents:
          // preserve those exact live cookies in memory and restore them.
          const matching = (await partition.cookies.get({ url, name, partitionKey: partitionKey ?? null }));
          try {
            await partition.cookies.remove(url, name, partitionKey);
            for (const entry of matching) {
              if (cookieKey(entry) !== wrongDomainKey) {
                await partition.cookies.set(storedCookieSetDetails(entry));
              }
            }
          } catch (error) {
            for (const entry of matching) {
              await partition.cookies.set(storedCookieSetDetails(entry));
            }
            throw error;
          }
        }
      }
      await partition.cookies.set({
        url, name, value: cookie.value,
        // Supplying domain, even without a leading dot, makes a domain cookie.
        ...(domain.startsWith('.') ? { domain } : {}),
        path, secure, httpOnly: cookie.httpOnly === true,
        sameSite: sameSite(cookie.sameSite),
        ...(!isSession ? { expirationDate: expirationDate as number } : {}),
        ...(partitionKey ? { partitionKey } : {}),
      });
      imported += 1;
    } catch {
      // Continue independent entries, but never report a partial import as success.
      // Raw Chromium errors may contain cookie values; report only counts.
      failed += 1;
    }
  }
  await partition.cookies.flushStore();
  if (failed) throw new CookieImportError(imported, failed, sourceFailures);
  return imported;
}

/**
 * "로그인 유지 중인 사이트": the sites the managed Browser Use profile stays
 * signed in to, with per-site sign-out and a full wipe. A site is a cookie
 * domain holding at least one HttpOnly cookie — the kind sign-ins use, since
 * page scripts can never read it; a subdomain folds into a listed parent
 * (accounts.example.com into example.com). Only site names and counts leave
 * here: cookie names and values never do.
 */
import type { BrowserCookie, BrowserCookieJar } from './cookie-jar';

export interface BrowserSignedInSite {
  site: string;
  /** Cookies of every kind the site keeps; all of them go on sign-out. */
  cookies: number;
}

const hostOf = (cookie: BrowserCookie) =>
  String(cookie.domain || '')
    .replace(/^\./, '')
    .toLowerCase();

const within = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/** The listed sites, most cookies first. */
export function signedInSites(cookies: readonly BrowserCookie[]): BrowserSignedInSite[] {
  const authHosts = new Set(
    cookies
      .filter((cookie) => cookie.httpOnly === true)
      .map(hostOf)
      .filter(Boolean)
  );
  // Shortest first, so a parent is listed before the subdomains it absorbs.
  const sites: string[] = [];
  for (const host of [...authHosts].sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b))) {
    if (!sites.some((site) => within(host, site))) sites.push(host);
  }
  return sites
    .map((site) => ({ site, cookies: cookies.filter((cookie) => within(hostOf(cookie), site)).length }))
    .sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
}

/** A site name from the renderer: a bare lowercase host, nothing else. */
export function normalizeSignedInSite(value: unknown): string {
  const site = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!site || site.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(site)) {
    throw new TypeError('Signed-in site is invalid.');
  }
  return site;
}

export function createBrowserSignIns(host: {
  cookies: Pick<BrowserCookieJar, 'get' | 'remove'>;
  /** Clears a page origin's storage (local/session storage, IndexedDB, caches…), cookies aside. */
  clearOriginStorage(origin: string): Promise<void>;
  /** Clears everything the partition stores. */
  clearAllStorage(): Promise<void>;
  /** Deletes the copied Chrome data: password vault, history, cookie backups. */
  clearImportedData(): Promise<void>;
  /** Rewrites the sealed session-cookie snapshot from the jar as it is now. */
  saveSessionCookies(): Promise<unknown>;
  /** Stops auto sign-in for the site's saved logins, so signing out is not
   *  undone by the agent signing straight back in. */
  pauseAutoSignIn?(site: string): Promise<void>;
}) {
  async function list(): Promise<BrowserSignedInSite[]> {
    return signedInSites(await host.cookies.get({}));
  }

  /** Sign out of `site`: its cookies (every subdomain and partition) and its pages' storage. */
  async function signOut(site: string): Promise<number> {
    const cookies = (await host.cookies.get({})).filter((cookie) => within(hostOf(cookie), site));
    const origins = new Set<string>();
    for (const cookie of cookies) {
      const cookieHost = hostOf(cookie);
      origins.add(`https://${cookieHost}`).add(`http://${cookieHost}`);
      const url = `${cookie.secure ? 'https' : 'http'}://${cookieHost}${cookie.path || '/'}`;
      await host.cookies.remove(url, cookie.name, cookie.partitionKey);
    }
    origins.add(`https://${site}`).add(`http://${site}`);
    for (const origin of origins) await host.clearOriginStorage(origin);
    // A saved password stays, but auto sign-in must not undo the sign-out.
    await host.pauseAutoSignIn?.(site);
    // The sealed copy must not bring the sign-in back at the next start.
    await host.saveSessionCookies();
    return cookies.length;
  }

  /** "전체 지우기": every sign-in, every site's storage and the imported Chrome data. */
  async function clearAll(): Promise<void> {
    await host.clearAllStorage();
    await host.clearImportedData();
    await host.saveSessionCookies();
  }

  return { list, signOut, clearAll };
}

import type { BrowserCookie, BrowserCookieJar } from './cookie-jar';
import { cookieHost, signOutCookieMatcher, validSignOutSite } from './cookie-sign-out-scopes';

export interface BrowserSignedInSite {
  site: string;
  /** Cookies of every kind the site keeps; all of them go on sign-out. */
  cookies: number;
}

const hostOf = (cookie: BrowserCookie) => cookieHost(cookie.domain);

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
  if (!validSignOutSite(site)) {
    throw new TypeError('Signed-in site is invalid.');
  }
  return site;
}

export function createBrowserSignIns(host: {
  cookies: Pick<BrowserCookieJar, 'get' | 'remove' | 'removeExact' | 'flushStore'>;
  /** Clears a page origin's storage (local/session storage, IndexedDB, caches…), cookies aside. */
  clearOriginStorage(origin: string): Promise<void>;
  /** Clears everything the partition stores. */
  clearAllStorage(): Promise<void>;
  /** Deletes the copied Chrome data: password vault, history, cookie backups. */
  clearImportedData(): Promise<void>;
  /** Stops auto sign-in for the site's saved logins, so signing out is not
   *  undone by the agent signing straight back in. */
  pauseAutoSignIn?(site: string): Promise<void>;
  /** Persist before deleting; serialize the entire operation with cookie imports. */
  withSiteSignOut?(site: string, work: () => Promise<number>): Promise<number>;
  withCookieMutation?(work: () => Promise<void>): Promise<void>;
}) {
  async function list(): Promise<BrowserSignedInSite[]> {
    return signedInSites(await host.cookies.get({}));
  }

  /** Sign out of `site`: its cookies (every subdomain and partition) and its pages' storage. */
  async function deleteSiteCookies(site: string): Promise<number> {
    const matches = signOutCookieMatcher([site]);
    const cookies = (await host.cookies.get({})).filter((cookie) => matches(cookie.domain, cookie.hostOnly));
    const origins = new Set<string>();
    for (const cookie of cookies) {
      const cookieHost = hostOf(cookie);
      // A shared parent cookie can reach the selected site, but its parent's
      // unrelated origin storage is out of scope.
      if (within(cookieHost, site)) origins.add(`https://${cookieHost}`).add(`http://${cookieHost}`);
      if (host.cookies.removeExact) await host.cookies.removeExact(cookie);
      else {
        const url = `${cookie.secure ? 'https' : 'http'}://${cookieHost}${cookie.path || '/'}`;
        await host.cookies.remove(url, cookie.name, cookie.partitionKey);
      }
    }
    origins.add(`https://${site}`).add(`http://${site}`);
    for (const origin of origins) await host.clearOriginStorage(origin);
    // A saved password stays, but auto sign-in must not undo the sign-out.
    await host.pauseAutoSignIn?.(site);
    await host.cookies.flushStore?.();
    return cookies.length;
  }

  function signOut(site: string): Promise<number> {
    const remove = () => deleteSiteCookies(site);
    return host.withSiteSignOut ? host.withSiteSignOut(site, remove) : remove();
  }

  /** "전체 지우기": every sign-in, every site's storage and the imported Chrome data. */
  function clearAll(): Promise<void> {
    const clear = async () => {
      await host.clearImportedData();
      await host.clearAllStorage();
    };
    return host.withCookieMutation ? host.withCookieMutation(clear) : clear();
  }

  return { list, signOut, clearAll };
}

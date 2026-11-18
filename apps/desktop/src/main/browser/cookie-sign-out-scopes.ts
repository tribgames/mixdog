import { readFile, rm } from 'node:fs/promises';
import { writeJsonAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';

export function cookieHost(domain: unknown): string {
  return typeof domain === 'string' ? domain.replace(/^\./, '').toLowerCase() : '';
}

export function validSignOutSite(site: string): boolean {
  return site.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(site);
}

function parent(host: string): string {
  const dot = host.indexOf('.');
  return dot < 0 ? '' : host.slice(dot + 1);
}

/** Partition keys do not change the cookie's own host scope. A shared
 * domain cookie on a parent is included if it can sign in the selected site. */
export function signOutCookieMatcher(sites: readonly string[]) {
  const scopes = new Set(sites);
  const sharedParents = new Set<string>();
  for (const site of scopes) {
    for (let host = parent(site); host; host = parent(host)) sharedParents.add(host);
  }
  return (domain: unknown, hostOnly?: boolean): boolean => {
    if (typeof domain !== 'string') return false;
    const host = cookieHost(domain);
    if ((hostOnly === false || (hostOnly === undefined && domain.startsWith('.'))) && sharedParents.has(host)) {
      return true;
    }
    for (let scope = host; scope; scope = parent(scope)) if (scopes.has(scope)) return true;
    return false;
  };
}

/** Durable intent for the managed cookie jar, not for the currently selected Chrome profile. */
export class CookieSignOutScopes {
  constructor(private readonly file: string) {}

  async read(): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.some((site) => typeof site !== 'string' || !validSignOutSite(site))) {
      throw new Error('Could not read the browser’s saved sign-out settings.');
    }
    return rows;
  }

  async add(site: string): Promise<void> {
    if (!validSignOutSite(site)) throw new TypeError('Signed-in site is invalid.');
    const rows = await this.read();
    if (!rows.includes(site)) await writeJsonAtomicAsync(this.file, [...rows, site], { secret: true });
  }

  clear(): Promise<void> {
    return rm(this.file, { force: true });
  }
}

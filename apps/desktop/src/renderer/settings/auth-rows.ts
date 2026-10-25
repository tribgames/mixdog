// 설정 › 인증 관리's list: one row per site, merging the saved logins (vault)
// with the cookie sign-ins the profile keeps, plus one row per remembered
// "Continue with Google/GitHub" sign-in. No secret ever reaches here — the
// vault summary carries only whether a password or an authenticator key is
// stored, never their values, and a linked sign-in only its identity.
import type {
  DesktopBrowserSignedInSite,
  DesktopLinkedSignIn,
  DesktopVaultLogin,
  DesktopVaultLoginSource,
} from '../../shared/contract';
import { linkedProviderLabel } from '../../shared/linked-sign-in-label';

export type AuthFilter = 'all' | 'password' | 'cookies';

export interface AuthRow {
  /** Stable list key: the login id, or `site:<host>` for a cookie-only row. */
  key: string;
  host: string;
  /** The login's HTTPS origin, or '' for a cookie-only row. */
  origin: string;
  loginId?: string;
  username?: string;
  hasPassword: boolean;
  hasTotp: boolean;
  cookies: number;
  source?: DesktopVaultLoginSource;
  autoSignIn: boolean;
  /** A password is stored but the site has no cookies: signed out. */
  loggedOut: boolean;
  /** A linked sign-in row: its record and provider label (the account, if
   *  known, is `username`). */
  linked?: { id: string; provider: string };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

/** Merge saved logins and cookie sign-ins into one row per login, plus a row
 *  for every site that has cookies but no saved login, and one per linked
 *  sign-in. A login's row carries its site's cookie count, so cookies and a
 *  password read as one site. */
export function mergeAuthRows(
  logins: readonly DesktopVaultLogin[],
  sites: readonly DesktopBrowserSignedInSite[],
  linked: readonly DesktopLinkedSignIn[] = []
): AuthRow[] {
  const cookiesByHost = new Map(sites.map((site) => [site.site, site.cookies]));
  const loginHosts = new Set<string>();
  const rows: AuthRow[] = [];
  for (const login of logins) {
    const host = hostOf(login.origin);
    if (!host) continue;
    const cookies = cookiesByHost.get(host) ?? 0;
    loginHosts.add(host);
    rows.push({
      key: login.id,
      host,
      origin: login.origin,
      loginId: login.id,
      username: login.username,
      hasPassword: login.hasPassword,
      hasTotp: login.hasTotp,
      cookies,
      source: login.source,
      autoSignIn: login.autoSignIn,
      loggedOut: login.hasPassword && cookies === 0,
    });
  }
  for (const site of sites) {
    if (loginHosts.has(site.site)) continue;
    rows.push({
      key: `site:${site.site}`,
      host: site.site,
      origin: '',
      hasPassword: false,
      hasTotp: false,
      cookies: site.cookies,
      autoSignIn: true,
      loggedOut: false,
    });
  }
  for (const link of linked) {
    rows.push({
      key: `linked:${link.id}`,
      host: link.site,
      origin: '',
      username: link.identity,
      hasPassword: false,
      hasTotp: false,
      cookies: 0,
      autoSignIn: true,
      loggedOut: false,
      linked: { id: link.id, provider: linkedProviderLabel(link.provider) },
    });
  }
  return rows.sort(
    (a, b) => a.host.localeCompare(b.host) || (a.username || '').localeCompare(b.username || '')
  );
}

/** 전체 / 비밀번호 저장 / 로그인 유지만 counts, a password row and a
 *  cookie-only row partitioning the whole list. A linked sign-in holds no
 *  password: it counts (and filters) with the cookie-only rows. */
export function authCounts(rows: readonly AuthRow[]): Record<AuthFilter, number> {
  const password = rows.filter((row) => row.hasPassword).length;
  return { all: rows.length, password, cookies: rows.length - password };
}

export function filterAuthRows(rows: readonly AuthRow[], filter: AuthFilter, query: string): AuthRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === 'password' && !row.hasPassword) return false;
    if (filter === 'cookies' && row.hasPassword) return false;
    if (!needle) return true;
    return (
      row.host.toLowerCase().includes(needle) ||
      (row.username || '').toLowerCase().includes(needle) ||
      Boolean(row.linked?.provider.toLowerCase().includes(needle))
    );
  });
}

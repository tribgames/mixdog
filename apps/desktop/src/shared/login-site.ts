import { getDomain } from 'tldts';

/** The site a sign-in page belongs to, as the login card names it: its
 *  registrable domain from the public suffix list (private suffixes included,
 *  so `user.github.io` stays itself and `a.example.co.kr` reads
 *  `example.co.kr`). IP addresses, localhost and other hosts without one
 *  read as the host itself. */
export function loginSiteLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

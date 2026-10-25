/**
 * Which saved pages a session restore recreates. A page with no address left
 * (blank, never loaded) or one the URL policy no longer admits has nothing to
 * come back to: it is dropped, so a restore never shows blank tabs.
 */
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';

export function restorablePages<T extends { url: string }>(
  saved: readonly T[],
  policy: BrowserUrlPolicy
): Array<{ page: T; url: string }> {
  const pages: Array<{ page: T; url: string }> = [];
  for (const page of saved) {
    if (!page.url || page.url === 'about:blank') continue;
    try {
      pages.push({ page, url: normalizePageUrl(page.url, policy) });
    } catch {
      // No longer admitted: dropped with the other pages that cannot come back.
    }
  }
  return pages;
}

import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';

export function restorablePages<T extends { url: string; standIn?: boolean }>(
  saved: readonly T[],
  policy: BrowserUrlPolicy
): Array<{ page: T; url: string }> {
  const pages: Array<{ page: T; url: string }> = [];
  for (const page of saved) {
    if (!page.url || page.url === 'about:blank') {
      if (!page.standIn) pages.push({ page, url: 'about:blank' });
      continue;
    }
    try {
      pages.push({ page, url: normalizePageUrl(page.url, policy) });
    } catch {
      // No longer admitted: dropped with the other pages that cannot come back.
    }
  }
  return pages;
}

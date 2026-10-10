// Android self-update: the APK is distributed as a GitHub Release asset on
// `mobile-v*` tags. The app asks the public Releases API for a newer one and
// offers the download; installing stays with the system package installer.

export const RELEASES_API = 'https://api.github.com/repos/tribgames/mixdog/releases?per_page=20';
const TAG_PREFIX = 'mobile-v';

export interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}
export interface ReleaseInfo {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  html_url?: unknown;
  assets?: unknown;
}
export interface AvailableUpdate {
  version: string;
  apkUrl: string;
  releaseUrl: string;
}

/** Numeric dotted compare; a non-numeric or missing part counts as 0. */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/** The newest published `mobile-v*` release that carries an APK and is newer
 *  than the installed version. */
export function pickUpdate(releases: unknown, installedVersion: string): AvailableUpdate | null {
  if (!Array.isArray(releases)) return null;
  let best: AvailableUpdate | null = null;
  for (const release of releases as ReleaseInfo[]) {
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
    if (!tag.startsWith(TAG_PREFIX) || release.draft === true || release.prerelease === true) continue;
    const version = tag.slice(TAG_PREFIX.length);
    if (!/^\d+(?:\.\d+)*$/u.test(version)) continue;
    const apk = (Array.isArray(release.assets) ? (release.assets as ReleaseAsset[]) : []).find(
      (asset) =>
        typeof asset?.name === 'string' &&
        asset.name.endsWith('.apk') &&
        typeof asset.browser_download_url === 'string' &&
        asset.browser_download_url.startsWith('https://')
    );
    if (!apk) continue;
    if (compareVersions(version, installedVersion) <= 0) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = {
      version,
      apkUrl: String(apk.browser_download_url),
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : '',
    };
  }
  return best;
}

export async function checkForUpdate(
  installedVersion: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4_000
): Promise<AvailableUpdate | null> {
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return pickUpdate(await response.json(), installedVersion);
  } catch {
    return null;
  }
}

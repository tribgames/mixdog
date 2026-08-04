// Settings → Git: cached panel snapshot (Connection-card grammar) so entering
// the category paints complete rows instantly instead of popping them in one
// probe at a time (user: GIT 캐시 — 들어갈 때 툭 나오게 하지 말 것).
// Stale-while-revalidate: the cached snapshot paints, and every preload
// refreshes it in the background.
import type {
  DesktopApi,
  DesktopGithubCliAccount,
  DesktopGithubCliStatus,
  DesktopGitPreferences,
} from '../../shared/contract';

export type GitPanelApi = Partial<Pick<DesktopApi,
  'githubCliStatus' | 'githubCliAccount' | 'readGitPreferences'>>;

/** Same-window broadcast fired after every git-preferences save, so already
 *  mounted consumers (SourceControlDock's commit gating) adopt the change
 *  immediately instead of waiting for their next preferences read
 *  (user: 온으로 바꾸고 나가면 커밋창이 바로 활성화돼야 한다). */
export const GIT_PREFERENCES_EVENT = 'mixdog:git-preferences-changed';

export function publishGitPreferences(
  host: GitPanelApi | undefined,
  preferences: DesktopGitPreferences,
): void {
  patchCachedGitPanelInfo(host, { preferences });
  try {
    window.dispatchEvent(new CustomEvent(GIT_PREFERENCES_EVENT, { detail: preferences }));
  } catch { /* consumers re-read on their own schedule */ }
}

export interface GitPanelInfo {
  status: DesktopGithubCliStatus | null;
  account: DesktopGithubCliAccount | null;
  preferences: DesktopGitPreferences | null;
}

interface GitPanelInfoCacheEntry {
  value?: GitPanelInfo;
  promise?: Promise<GitPanelInfo | null>;
}

const gitPanelInfoCache = new WeakMap<object, GitPanelInfoCacheEntry>();

function cacheEntry(host: object): GitPanelInfoCacheEntry {
  let entry = gitPanelInfoCache.get(host);
  if (!entry) {
    entry = {};
    gitPanelInfoCache.set(host, entry);
  }
  return entry;
}

export function getCachedGitPanelInfo(host: GitPanelApi | undefined): GitPanelInfo | undefined {
  return host ? gitPanelInfoCache.get(host)?.value : undefined;
}

/** Panel actions (connect/disconnect/install/save) publish their fresh
 *  results here so the next open paints them without waiting for a probe. */
export function patchCachedGitPanelInfo(
  host: GitPanelApi | undefined,
  patch: Partial<GitPanelInfo>,
): void {
  if (!host) return;
  const entry = cacheEntry(host);
  entry.value = {
    status: null,
    account: null,
    preferences: null,
    ...entry.value,
    ...patch,
  };
}

export function preloadGitPanelInfo(host: GitPanelApi | undefined): Promise<GitPanelInfo | null> {
  if (!host?.githubCliStatus) return Promise.resolve(null);
  const entry = cacheEntry(host);
  if (entry.promise) return entry.promise;
  entry.promise = (async (): Promise<GitPanelInfo> => {
    // A failed probe keeps the last known value — a transient gh/IPC hiccup
    // must not blank an already-painted card.
    const [status, preferences] = await Promise.all([
      host.githubCliStatus!().catch(() => entry.value?.status ?? null),
      host.readGitPreferences
        ? host.readGitPreferences().catch(() => entry.value?.preferences ?? null)
        : Promise.resolve<DesktopGitPreferences | null>(null),
    ]);
    const account = status?.authenticated
      ? await (host.githubCliAccount
        ? host.githubCliAccount().catch(() => entry.value?.account ?? null)
        : Promise.resolve<DesktopGithubCliAccount | null>(null))
      : null;
    entry.value = {
      status: status ?? null,
      account: account ?? null,
      preferences: preferences ?? null,
    };
    return entry.value;
  })().finally(() => { entry.promise = undefined; });
  return entry.promise;
}

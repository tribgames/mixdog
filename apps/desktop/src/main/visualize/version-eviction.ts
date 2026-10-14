/**
 * The version budget of one session: per-tab and per-session caps, oldest
 * first, never dropping a tab's newest version or a pinned (shown) one.
 */
import type { VisualizeVersion } from './versions';

type Kept = Pick<VisualizeVersion, 'n' | 'at' | 'bytes'>;
type SessionTabs<V extends Kept> = Map<string, { versions: V[] }>;
/** The version `tabId` shows (never evicted), or null. */
type Pinned = (tabId: string) => number | null;

/** Bytes eviction can never free once `tabId` gains a new newest version:
 *  every other tab's newest and every pinned (shown) version. */
export function floorBytes(tabs: SessionTabs<Kept> | undefined, pinned: Pinned, tabId: string): number {
  let bytes = 0;
  for (const [id, history] of tabs ?? []) {
    const shown = pinned(id);
    const last = history.versions.length - 1;
    history.versions.forEach((version, index) => {
      if (version.n === shown || (index === last && id !== tabId)) bytes += version.bytes;
    });
  }
  return bytes;
}

/** Remove versions past `maxPerTab` per tab, then past `maxSessionBytes` in
 *  total, oldest first; a tab's newest version and every pinned one stay.
 *  Returns the removed versions (their files are the caller's). */
export function evictVersions<V extends Kept>(
  tabs: SessionTabs<V>,
  pinned: Pinned,
  maxPerTab: number,
  maxSessionBytes: number
): V[] {
  const removed: V[] = [];
  const evictable = (tabId: string, history: { versions: V[] }) => {
    const shown = pinned(tabId);
    return history.versions.findIndex((version, index) => index < history.versions.length - 1 && version.n !== shown);
  };
  for (const [tabId, history] of tabs) {
    while (history.versions.length > maxPerTab) {
      const index = evictable(tabId, history);
      if (index < 0) break;
      removed.push(...history.versions.splice(index, 1));
    }
  }
  let total = [...tabs.values()].reduce(
    (sum, history) => sum + history.versions.reduce((tabSum, version) => tabSum + version.bytes, 0),
    0
  );
  while (total > maxSessionBytes) {
    let pick: { history: { versions: V[] }; index: number; at: number } | null = null;
    for (const [tabId, history] of tabs) {
      const index = evictable(tabId, history);
      if (index < 0) continue;
      const at = history.versions[index].at;
      if (!pick || at < pick.at) pick = { history, index, at };
    }
    if (!pick) break;
    const [version] = pick.history.versions.splice(pick.index, 1);
    removed.push(version);
    total -= version.bytes;
  }
  return removed;
}

// Last app version whose first launch was announced. A fresh install has
// nothing to announce, so it only records the current version.
export const SEEN_VERSION_KEY = 'mixdog.desktop.whats-new-seen-version';

type VersionStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** True exactly once per version after an update; records `version` as seen. */
export function takeWhatsNew(storage: VersionStorage | undefined, version: string): boolean {
  try {
    if (!storage) return false;
    const seen = storage.getItem(SEEN_VERSION_KEY);
    if (seen === version) return false;
    storage.setItem(SEEN_VERSION_KEY, version);
    return Boolean(seen);
  } catch {
    // Storage unavailable: stay quiet rather than repeating every launch.
    return false;
  }
}

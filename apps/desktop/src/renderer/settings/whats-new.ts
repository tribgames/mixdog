// Last app version whose first launch was announced. A fresh install has
// nothing to announce, so it only records the current version.
import { compareSemver } from '../../../../../src/runtime/shared/semver.mjs';

export const SEEN_VERSION_KEY = 'mixdog.desktop.whats-new-seen-version';

type VersionStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type WhatsNewStatus =
  | 'pending'
  | 'fresh-install'
  | 'current'
  | 'already-shown'
  | 'downgrade'
  | 'storage-unavailable';

// Versions announced during this session, so a remount never repeats one even
// when the stored mark could not be written.
const shownVersions = new Set<string>();

/**
 * Whether `version` should be announced. Only a fresh install writes (it has
 * nothing to announce, so it records the version); an update leaves the stored
 * value alone until `markWhatsNewSeen`, so a notice that failed to render is
 * retried on the next launch. An empty mark is a fresh install only when the
 * main process does not report this launch as following an update
 * (`afterUpdate`): localStorage can be lost while the install lives on.
 */
export function peekWhatsNew(
  storage: VersionStorage | undefined,
  version: string,
  afterUpdate = false
): WhatsNewStatus {
  try {
    if (!storage) return 'storage-unavailable';
    if (shownVersions.has(version)) return 'already-shown';
    const seen = storage.getItem(SEEN_VERSION_KEY);
    if (seen === version) return 'current';
    if (!seen) {
      if (afterUpdate) return 'pending';
      storage.setItem(SEEN_VERSION_KEY, version);
      return 'fresh-install';
    }
    // Only a newer version is announced. A downgrade keeps the newer mark, so
    // returning to that version later does not announce it a second time.
    return compareSemver(version, seen) > 0 ? 'pending' : 'downgrade';
  } catch {
    // Storage unavailable: stay quiet rather than repeating every launch.
    return 'storage-unavailable';
  }
}

/** Record `version` as announced; call once the notice is actually on screen. */
export function markWhatsNewSeen(storage: VersionStorage | undefined, version: string): void {
  shownVersions.add(version);
  try {
    storage?.setItem(SEEN_VERSION_KEY, version);
  } catch {
    /* the in-memory mark still prevents a repeat this session */
  }
}

/** Trace the notice in desktop-diagnostics.jsonl (`renderer-whats-new`). */
export function reportWhatsNew(
  event: 'taken' | 'shown' | 'skipped' | 'failed',
  version: string,
  detail?: { reason?: string; error?: unknown }
): void {
  try {
    const error = detail?.error;
    const errorName = error instanceof Error ? error.name : 'Error';
    window.mixdogDesktop?.rendererDiagnostic?.({
      kind: 'whats-new',
      event,
      version,
      ...(detail?.reason ? { reason: detail.reason } : {}),
      ...(error === undefined
        ? {}
        : {
            errorName,
            message: String((error as Error)?.message ?? error),
          }),
    });
  } catch {
    /* diagnostics only */
  }
}

// Side-by-side renderer releases. Each desktop build ships its own web
// renderer; the relay keeps several and serves a phone / second PC the one that
// matches the desktop version of the main PC it is paired with.
//
// Layout of RENDERER_RELEASES_DIR (default: `renderer-releases` beside
// RENDERER_DIR):
//   index.json      the registry below (written atomically by deploy tooling)
//   <releaseId>/    one complete staged renderer tree per release
//
// Selection rule (selectRelease), first match wins:
//   1. the device reported a renderer release id (shell version hash) that a
//      retained release carries                          -> that release
//   2. the device reported an app version equal to a retained release's
//      desktop version                                   -> newest such release
//   3. the device reported an app version and some retained release is for an
//      older-or-equal desktop version -> the highest such version (the newest
//      compatible build; a desktop newer than every retained release gets the
//      newest one)
//   4. everything else (old desktops that never report a version, versions
//      older than every retained release)                -> the LEGACY release,
//      i.e. the renderer that was current when this feature shipped
//   5. no legacy release registered                      -> the newest release
//
// Retention rule (planRetention): the legacy release is never collected; the
// newest KEEP_LATEST_RELEASES releases are kept; any release still selected for
// a device seen within DEVICE_REFERENCE_WINDOW_MS is kept too, newest first,
// until MAX_RETAINED_RELEASES releases (excluding legacy) are retained.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LEGACY_RELEASE_ID = 'legacy';
export const RELEASE_INDEX_FILE = 'index.json';
export const KEEP_LATEST_RELEASES = 3;
export const MAX_RETAINED_RELEASES = 6;
export const DEVICE_REFERENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
export const DESKTOP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
export const SHELL_VERSION = /^[a-f0-9]{64}$/;

export function isReleaseId(value) {
  return RELEASE_ID.test(String(value || ''));
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Validate a registry document; throws on anything malformed. */
export function parseReleaseIndex(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.releases)) {
    throw new Error('renderer release index is missing or incompatible');
  }
  const seen = new Set();
  let legacyCount = 0;
  const releases = value.releases.map((entry) => {
    const legacy = entry?.legacy === true;
    const desktopVersion = String(entry?.desktopVersion ?? '');
    const shellVersion = String(entry?.shellVersion ?? '');
    if (!isReleaseId(entry?.id) || seen.has(entry.id)) throw new Error('renderer release id is invalid');
    if (desktopVersion ? !DESKTOP_VERSION.test(desktopVersion) : !legacy) {
      throw new Error('renderer release desktop version is invalid');
    }
    if (shellVersion && !SHELL_VERSION.test(shellVersion)) throw new Error('renderer release shell version is invalid');
    if (!Number.isFinite(entry.addedAt)) throw new Error('renderer release timestamp is invalid');
    if (legacy) legacyCount += 1;
    seen.add(entry.id);
    return { id: entry.id, desktopVersion, shellVersion, addedAt: entry.addedAt, legacy };
  });
  if (legacyCount > 1) throw new Error('renderer release index has more than one legacy release');
  return { schemaVersion: 1, releases };
}

/** The registry in `releasesDir`: null when none exists, throws when invalid. */
export function readReleaseIndex(releasesDir) {
  let text;
  try {
    text = readFileSync(join(releasesDir, RELEASE_INDEX_FILE), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  return parseReleaseIndex(JSON.parse(text));
}

function newestOf(entries) {
  let best = null;
  for (const entry of entries) if (!best || entry.addedAt >= best.addedAt) best = entry;
  return best;
}

/** The registry entry a device should be served; see the rule at the top. */
export function selectRelease(index, { appVersion = '', rendererRelease = '' } = {}) {
  const entries = index.releases.filter((entry) => !entry.legacy);
  if (rendererRelease) {
    const hit = newestOf(entries.filter((entry) => entry.shellVersion === rendererRelease));
    if (hit) return hit;
  }
  if (appVersion) {
    const exact = newestOf(entries.filter((entry) => entry.desktopVersion === appVersion));
    if (exact) return exact;
    const wanted = parseVersion(appVersion);
    if (wanted) {
      let best = null;
      let bestVersion = null;
      for (const entry of entries) {
        const version = parseVersion(entry.desktopVersion);
        if (!version || compareVersions(version, wanted) > 0) continue;
        const order = bestVersion ? compareVersions(version, bestVersion) : 1;
        if (order > 0 || (order === 0 && entry.addedAt >= best.addedAt)) {
          best = entry;
          bestVersion = version;
        }
      }
      if (best) return best;
    }
  }
  return index.releases.find((entry) => entry.legacy) ?? newestOf(entries);
}

/** The registry with `entry` added; an already registered id is left as is. */
export function withRelease(index, entry) {
  if (index.releases.some((existing) => existing.id === entry.id)) return index;
  return parseReleaseIndex({ schemaVersion: 1, releases: [...index.releases, entry] });
}

/** Which releases survive garbage collection. `devices` rows carry
 *  { appVersion, rendererRelease, seenAt }. */
export function planRetention(
  index,
  devices = [],
  {
    now = Date.now(),
    keepLatest = KEEP_LATEST_RELEASES,
    maxRetained = MAX_RETAINED_RELEASES,
    windowMs = DEVICE_REFERENCE_WINDOW_MS,
  } = {}
) {
  const newestFirst = index.releases.filter((entry) => !entry.legacy).sort((a, b) => b.addedAt - a.addedAt);
  const keep = new Set(newestFirst.slice(0, keepLatest).map((entry) => entry.id));
  const referenced = new Set();
  for (const device of devices) {
    if (!(now - device.seenAt <= windowMs)) continue;
    const selected = selectRelease(index, device);
    if (selected && !selected.legacy) referenced.add(selected.id);
  }
  for (const entry of newestFirst) {
    if (keep.size >= maxRetained) break;
    if (referenced.has(entry.id)) keep.add(entry.id);
  }
  const legacy = index.releases.find((entry) => entry.legacy);
  if (legacy) keep.add(legacy.id);
  return {
    keep: index.releases.filter((entry) => keep.has(entry.id)).map((entry) => entry.id),
    drop: index.releases.filter((entry) => !keep.has(entry.id)).map((entry) => entry.id),
  };
}

/** Resolves the renderer tree to serve for a device. Without a registry it is
 *  the plain `rendererDir`, so a relay that was never given releases behaves
 *  exactly as before. */
export function createRendererCatalog({ rendererDir = '', releasesDir = '', cacheMs = 1000, now = Date.now } = {}) {
  let cached = null;
  let expiresAt = 0;
  const index = () => {
    if (!releasesDir) return null;
    const time = now();
    if (time < expiresAt) return cached;
    try {
      cached = readReleaseIndex(releasesDir);
    } catch {
      cached = null;
    }
    expiresAt = time + cacheMs;
    return cached;
  };
  return {
    rendererDir,
    releasesDir,
    index,
    dirFor(report) {
      const registry = index();
      const selected = registry?.releases.length ? selectRelease(registry, report) : null;
      if (!selected) return rendererDir;
      const dir = join(releasesDir, selected.id);
      try {
        return statSync(join(dir, 'index.html')).isFile() ? dir : rendererDir;
      } catch {
        return rendererDir;
      }
    },
  };
}

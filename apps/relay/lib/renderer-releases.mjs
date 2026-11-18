// Side-by-side renderer releases. Each desktop build ships its own web
// renderer; the relay keeps several and serves a phone / second PC the one that
// matches the desktop version of the main PC it is paired with.
//
// Layout of RENDERER_RELEASES_DIR (default: `renderer-releases` beside
// RENDERER_DIR):
//   index.json      the registry below (written atomically by deploy tooling)
//   <releaseId>/    one complete staged renderer tree per release
//
// A reported app version and shell hash must not conflict. An adopted shell
// that has no version metadata can match by exact hash if no known version
// contradicts it. Only silent PCs get a default.
//
// Retention rule (planRetention): the legacy release is never collected; the
// newest KEEP_LATEST_RELEASES releases are kept; any release still selected for
// a device seen within DEVICE_REFERENCE_WINDOW_MS is kept too, newest first,
// until MAX_RETAINED_RELEASES releases (excluding legacy) are retained.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LEGACY_RELEASE_ID = 'legacy';
export const RELEASE_INDEX_FILE = 'index.json';
const KEEP_LATEST_RELEASES = 3;
const MAX_RETAINED_RELEASES = 6;
const DEVICE_REFERENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
export const DESKTOP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
export const SHELL_VERSION = /^[a-f0-9]{64}$/;

function isReleaseId(value) {
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
    if (error?.code === 'ENOENT') return null;
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
  const entries = index.releases;
  const exact = appVersion ? entries.filter((entry) => entry.desktopVersion === appVersion) : [];
  const match = (entry) => entry.shellVersion === rendererRelease;
  if (appVersion) {
    if (rendererRelease) {
      const pinned = newestOf(exact.filter(match));
      if (pinned) return pinned;
      const adopted = entries.find((entry) => entry.legacy && !entry.desktopVersion && match(entry));
      if (adopted && !entries.some((entry) => entry.desktopVersion && match(entry))) return adopted;
    }
    return newestOf(exact);
  }
  if (rendererRelease) return newestOf(entries.filter(match));
  return entries.find((entry) => entry.legacy) ?? newestOf(entries);
}

/** The oldest desktop version any retained non-legacy release is built for
 *  (what a legacy-served desktop must update to); '' when there is none. */
export function oldestSupportedVersion(index) {
  let oldest = null;
  for (const entry of index.releases) {
    const version = entry.legacy ? null : parseVersion(entry.desktopVersion);
    if (version && (!oldest || compareVersions(version, oldest.version) < 0)) oldest = { version, entry };
  }
  return oldest ? oldest.entry.desktopVersion : '';
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
  let expiresAt = -Infinity;
  const selectFrom = (registry, report) => (registry?.releases.length ? selectRelease(registry, report) : null);
  const index = () => {
    if (!releasesDir) return null;
    const time = now();
    if (time < expiresAt) return cached;
    try {
      cached = readReleaseIndex(releasesDir);
    } catch {
      // null is reserved for a genuinely absent registry.
      cached = undefined;
    }
    expiresAt = time + cacheMs;
    return cached;
  };
  return {
    rendererDir,
    releasesDir,
    index,
    /** Only unmatched PCs see update advice; a verified legacy match still works. */
    legacyFor(report) {
      const registry = index();
      if (!registry) return null;
      const selected = selectFrom(registry, report);
      const minVersion = oldestSupportedVersion(registry);
      if (!report.appVersion) return !report.rendererRelease && selected?.legacy ? { minVersion } : null;
      const current = parseVersion(report.appVersion);
      const min = parseVersion(minVersion);
      return !selected && current && min && compareVersions(current, min) < 0 ? { minVersion } : null;
    },
    dirFor(report) {
      const registry = index();
      if (registry === null) return rendererDir;
      const selected = selectFrom(registry, report);
      if (!selected) return null;
      const dir = join(releasesDir, selected.id);
      try {
        return statSync(join(dir, 'index.html')).isFile() ? dir : null;
      } catch {
        return null;
      }
    },
  };
}

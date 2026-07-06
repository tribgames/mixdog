/**
 * update-checker.mjs — npm registry version check + self-update for the
 * globally-installed `mixdog` CLI package.
 *
 * checkLatestVersion({force}) hits the npm registry for the `latest`
 * dist-tag, compares against the local package.json version, and caches
 * the result on disk (TTL 24h) so repeated calls (e.g. on every TUI mount)
 * don't hammer the registry. Network/parse failures are silent — this is a
 * best-effort convenience check, never a boot-blocking dependency.
 *
 * runGlobalUpdate() shells out to `npm install -g mixdog@latest` in the
 * background (windowsHide so no console flash on Windows) and resolves once
 * the child exits, reporting the resolved version on success.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolvePluginData } from './plugin-paths.mjs';

const PACKAGE_NAME = 'mixdog';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'update-check-cache.json';

// Resolve the local package.json shipped alongside src/ (two levels up from
// src/runtime/shared/).
const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const _PACKAGE_JSON_PATH = join(_MODULE_DIR, '..', '..', '..', 'package.json');

let _localVersionCache = null;
export function localPackageVersion() {
  if (_localVersionCache) return _localVersionCache;
  try {
    const raw = JSON.parse(readFileSync(_PACKAGE_JSON_PATH, 'utf8'));
    _localVersionCache = String(raw?.version || '0.0.0');
  } catch {
    _localVersionCache = '0.0.0';
  }
  return _localVersionCache;
}

function cacheFilePath(dataDir) {
  const dir = dataDir || resolvePluginData();
  return join(dir, CACHE_FILE_NAME);
}

function readCache(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(cacheFilePath(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(dataDir, payload) {
  try {
    const dir = dataDir || resolvePluginData();
    mkdirSync(dir, { recursive: true });
    writeFileSync(cacheFilePath(dataDir), JSON.stringify(payload), 'utf8');
  } catch {
    // Best-effort — cache miss just means the next call re-fetches.
  }
}

/** Parse a semver-ish string into { parts:[maj,min,patch], prerelease }. */
function parseSemver(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const [core, ...preParts] = text.split('-');
  const parts = core.split('.').map((n) => {
    const num = Number.parseInt(n, 10);
    return Number.isFinite(num) ? num : 0;
  });
  while (parts.length < 3) parts.push(0);
  return { parts, prerelease: preParts.join('-') };
}

/**
 * Compare two semver strings. Returns positive if `a` > `b`, negative if
 * `a` < `b`, 0 if equal. A version with a prerelease tag is considered
 * lower than the same core version without one (standard semver rule).
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease !== pb.prerelease) return pa.prerelease < pb.prerelease ? -1 : 1;
  return 0;
}

export function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  return compareSemver(latest, current) > 0;
}

async function fetchLatestFromRegistry() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    const version = body && typeof body === 'object' ? String(body.version || '').trim() : '';
    return version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * checkLatestVersion({force, dataDir}) — resolve the latest published
 * version of the `mixdog` npm package.
 *
 * Returns:
 *   { currentVersion, latestVersion, updateAvailable, lastCheckedAt, fromCache }
 * `latestVersion` is null when the registry could not be reached and no
 * usable cache exists — this call never throws.
 */
export async function checkLatestVersion({ force = false, dataDir } = {}) {
  const currentVersion = localPackageVersion();
  const cache = force ? null : readCache(dataDir);
  const now = Date.now();
  if (cache && typeof cache.lastCheckedAt === 'number' && now - cache.lastCheckedAt < CACHE_TTL_MS) {
    return {
      currentVersion,
      latestVersion: cache.latestVersion || null,
      updateAvailable: isNewerVersion(cache.latestVersion, currentVersion),
      lastCheckedAt: cache.lastCheckedAt,
      fromCache: true,
    };
  }
  const latestVersion = await fetchLatestFromRegistry();
  if (latestVersion) {
    const payload = { latestVersion, lastCheckedAt: now };
    writeCache(dataDir, payload);
    return {
      currentVersion,
      latestVersion,
      updateAvailable: isNewerVersion(latestVersion, currentVersion),
      lastCheckedAt: now,
      fromCache: false,
    };
  }
  // Registry unreachable: fall back to a stale cache (if any) rather than
  // reporting "no update info" every time the network hiccups.
  // Re-read the cache here: a force:true call skips the read above, but a
  // stale answer still beats none when the network is down.
  const staleCache = cache || readCache(dataDir);
  if (staleCache && staleCache.latestVersion) {
    return {
      currentVersion,
      latestVersion: staleCache.latestVersion,
      updateAvailable: isNewerVersion(staleCache.latestVersion, currentVersion),
      lastCheckedAt: staleCache.lastCheckedAt || now,
      fromCache: true,
    };
  }
  return {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    lastCheckedAt: now,
    fromCache: false,
  };
}

/**
 * runGlobalUpdate() — `npm install -g mixdog@latest` in a background child
 * process (windowsHide so no console flash on Windows). Resolves once the
 * child exits; never throws — failures come back as {ok:false, error}.
 */
export function runGlobalUpdate() {
  return new Promise((resolvePromise) => {
    let child;
    try {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      child = spawn(npmCmd, ['install', '-g', `${PACKAGE_NAME}@latest`], {
        stdio: 'ignore',
        windowsHide: true,
        // detached: survive parent exit — quitting the TUI mid-install must
        // not kill npm halfway and leave the global install corrupted.
        detached: true,
        shell: process.platform === 'win32',
      });
    } catch (err) {
      resolvePromise({ ok: false, error: err?.message || String(err) });
      return;
    }
    child.once('error', (err) => {
      resolvePromise({ ok: false, error: err?.message || String(err) });
    });
    // Detach from the event-loop keep-alive so a boot-time auto-update can
    // never hold the TUI/node process open after the user quits; the exit
    // listener still fires as long as the process is otherwise alive.
    child.unref?.();
    child.once('exit', async (code) => {
      if (code === 0) {
        // Best-effort: report whichever version the registry now reports as
        // latest (the just-installed one), falling back to 'unknown'.
        const version = await fetchLatestFromRegistry();
        resolvePromise({ ok: true, version: version || 'unknown' });
      } else {
        resolvePromise({ ok: false, error: `npm install exited with code ${code}` });
      }
    });
  });
}

export { PACKAGE_NAME as UPDATE_PACKAGE_NAME };

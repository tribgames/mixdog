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

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolvePluginData } from './plugin-paths.mjs';
import { detachedSpawnOpts } from './spawn-flags.mjs';

const PACKAGE_NAME = 'mixdog';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE_NAME = 'update-check-cache.json';

// Resolve the local package.json shipped alongside src/ (two levels up from
// src/runtime/shared/).
const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const _PACKAGE_JSON_PATH = join(_MODULE_DIR, '..', '..', '..', 'package.json');
const _PACKAGE_ROOT = dirname(_PACKAGE_JSON_PATH);

/**
 * isDevInstall() — true when the running mixdog is a git checkout / clone (or
 * otherwise not a normal npm install), so auto-update must be skipped: an
 * `npm install -g mixdog@latest` would fight a linked/working-tree package.
 * Heuristics: a `.git` entry at the package root, OR the package directory not
 * living under any `node_modules/` path (global & local installs always do).
 */
export function isDevInstall() {
  try {
    if (existsSync(join(_PACKAGE_ROOT, '.git'))) return true;
  } catch { /* fall through to path heuristic */ }
  const norm = _PACKAGE_ROOT.replace(/\\/g, '/').toLowerCase();
  return !/\/node_modules\//.test(`/${norm}/`);
}

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
 * Resolve npm's JS entrypoint (npm-cli.js) next to the running node binary.
 * Running `node npm-cli.js …` directly avoids cmd.exe/PowerShell entirely on
 * Windows: no shell process means no console window can appear (and no
 * `-WindowStyle Hidden` style flags that antivirus heuristics flag).
 */
export function npmCliJsPath() {
  // When launched via npm itself, npm_execpath is authoritative.
  const envPath = process.env.npm_execpath;
  const candidates = envPath && /npm-cli\.js$/i.test(envPath) ? [envPath] : [];
  const execDirs = [dirname(process.execPath)];
  try {
    const realExecDir = dirname(realpathSync(process.execPath));
    if (!execDirs.includes(realExecDir)) execDirs.push(realExecDir);
  } catch { /* retain the raw executable path */ }

  for (const execDir of execDirs) {
    // Windows: npm ships beside node.exe.
    candidates.push(join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    // Unix layout: <prefix>/bin/node → <prefix>/lib/node_modules/npm.
    candidates.push(join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    // Homebrew: <prefix>/bin/node → <prefix>/libexec/lib/node_modules/npm.
    candidates.push(join(execDir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }

  // Last resort: npm shims on PATH commonly resolve into npm's package bin dir.
  const pathDirs = (process.env.PATH || process.env.Path || '').split(delimiter);
  for (const pathDir of pathDirs) {
    if (!pathDir) continue;
    const npmPaths = process.platform === 'win32'
      ? [join(pathDir, 'npm'), join(pathDir, 'npm.cmd')]
      : [join(pathDir, 'npm')];
    for (const npmPath of npmPaths) {
      try {
        if (!existsSync(npmPath)) continue;
        const resolvedNpm = realpathSync(npmPath);
        const npmBinDir = dirname(resolvedNpm);
        if (
          basename(npmBinDir) !== 'bin'
          || basename(dirname(npmBinDir)) !== 'npm'
          || basename(dirname(dirname(npmBinDir))) !== 'node_modules'
        ) continue;
        const cliJs = join(npmBinDir, 'npm-cli.js');
        if (existsSync(cliJs)) return cliJs;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * runGlobalUpdate() — `npm install -g mixdog@latest` in a background child
 * process. Prefers spawning node.exe with npm-cli.js directly (shell-less, so
 * Windows never opens a console window); falls back to npm.cmd via shell when
 * npm-cli.js cannot be located. Resolves once the child exits; never throws —
 * failures come back as {ok:false, error}.
 */
function runGlobalUpdate() {
  return new Promise((resolvePromise) => {
    let child;
    try {
      const installArgs = ['install', '-g', `${PACKAGE_NAME}@latest`];
      const cliJs = npmCliJsPath();
      const isWin = process.platform === 'win32';
      const [cmd, args, useShell] = cliJs
        ? [process.execPath, [cliJs, ...installArgs], false]
        : [isWin ? 'npm.cmd' : 'npm', installArgs, isWin];
      child = spawn(cmd, args, {
        stdio: 'ignore',
        shell: useShell,
        ...detachedSpawnOpts,
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

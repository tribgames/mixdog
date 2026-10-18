import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  copyFile as copyFileP,
  mkdir as mkdirP,
  readdir as readdirP,
  rm as rmP,
  stat as statP,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isPlainObject } from './object.mjs';
import { mixdogHome } from './plugin-paths.mjs';

// The root follows the isolated home (MIXDOG_HOME, then the legacy
// MIXDOG_CONFIG_DIR), so a dev profile keeps its backups inside its own
// profile; the installed app resolves to ~/.mixdog/backups/user-data.
function getBackupRoot() {
  return (
    process.env.MIXDOG_USER_DATA_BACKUP_ROOT ||
    join(process.env.MIXDOG_HOME || process.env.MIXDOG_CONFIG_DIR || mixdogHome(), 'backups', 'user-data')
  );
}

const USER_DATA_FILES = ['mixdog-config.json'];

const USER_DATA_DIRS = ['schedules', 'webhooks', 'workflows'];

// Written into every backup; a backup without one (legacy, or interrupted
// mid-copy) is never restored.
const BACKUP_MANIFEST = 'backup.json';

// Lives INSIDE the data dir: deleting or recreating the profile drops it, so a
// recreated profile at the same path is fresh. Its instanceId ties backups to
// this incarnation of the data dir.
const INIT_MARKER = '.mixdog-user-data.json';

const SCOPE_PREFIX = 'scope-';

function normalizeDataDir(dataDir) {
  const full = resolve(String(dataDir));
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

// Per-data-dir backup folder. The `scope-` prefix sorts after the timestamped
// legacy entries, so an older build pruning the root as one ring keeps it.
function scopeDirFor(dataDir) {
  const id = createHash('sha256').update(normalizeDataDir(dataDir)).digest('hex').slice(0, 16);
  return join(getBackupRoot(), `${SCOPE_PREFIX}${id}`);
}

let lastBackupTime = 0;

function stamp(names) {
  // Names own restore/prune order. Include unfinished directories because
  // their paths are occupied, and consult disk even after this writer starts.
  let previous = 0;
  for (const name of names) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(name);
    if (!match) continue;
    const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
    const time = Date.parse(iso);
    // Date.parse normalizes some invalid dates, such as a non-leap February 29.
    if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) continue;
    previous = time;
    break; // names are newest first
  }
  // Allocate after directory discovery, without yielding before reserving the
  // counter shared by sync and async calls in this module.
  lastBackupTime = Math.max(Date.now(), lastBackupTime + 1, previous + 1);
  return new Date(lastBackupTime).toISOString().replace(/[:.]/g, '-');
}

function safeReason(reason) {
  return (
    String(reason || 'snapshot')
      .replace(/[^a-z0-9_.-]+/gi, '-')
      .slice(0, 48) || 'snapshot'
  );
}

/** instanceId of this data dir's init marker; null when absent or unreadable. */
function readInitInstanceId(dataDir) {
  if (!dataDir) return null;
  try {
    const marker = JSON.parse(readFileSync(join(dataDir, INIT_MARKER), 'utf8'));
    return typeof marker?.instanceId === 'string' && marker.instanceId ? marker.instanceId : null;
  } catch {
    return null;
  }
}

export function hasUserDataInitMarker(dataDir) {
  return readInitInstanceId(dataDir) != null;
}

// Older builds kept one unscoped ring plus `.initialized-<hash>.json` markers
// under MIXDOG_CONFIG_DIR (or ~/.mixdog), ignoring MIXDOG_HOME.
function legacyBackupRoots() {
  const legacy =
    process.env.MIXDOG_USER_DATA_BACKUP_ROOT ||
    join(process.env.MIXDOG_CONFIG_DIR || join(homedir(), '.mixdog'), 'backups', 'user-data');
  const current = getBackupRoot();
  return normalizeDataDir(legacy) === normalizeDataDir(current) ? [current] : [current, legacy];
}

function manifestDataDirMatches(backupDir, dataDirKey) {
  try {
    const manifest = JSON.parse(readFileSync(join(backupDir, BACKUP_MANIFEST), 'utf8'));
    return typeof manifest?.dataDir === 'string' && normalizeDataDir(manifest.dataDir) === dataDirKey;
  } catch {
    return false;
  }
}

function legacyMarkersFor(root, dataDir, dataDirKey) {
  const hashed = new Set(
    [String(dataDir), resolve(String(dataDir))].map(
      (value) => `.initialized-${createHash('sha256').update(value).digest('hex').slice(0, 16)}.json`
    )
  );
  let names = [];
  try {
    names = readdirSync(root).filter((name) => name.startsWith('.initialized-') && name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      if (hashed.has(name)) return true;
      try {
        const marker = JSON.parse(readFileSync(join(root, name), 'utf8'));
        return typeof marker?.dataDir === 'string' && normalizeDataDir(marker.dataDir) === dataDirKey;
      } catch {
        return false;
      }
    })
    .map((name) => join(root, name));
}

/**
 * Evidence that a data dir without the in-dir marker was initialized by an
 * older build: a legacy marker for it, or an unscoped backup whose manifest
 * names it. Null when there is none, or when the data dir was already migrated
 * (scoped backups exist), so a recreated profile stays fresh.
 */
export function findLegacyUserDataEvidence(dataDir, { fresh = false } = {}) {
  if (!dataDir || hasUserDataInitMarker(dataDir)) return null;
  const key = normalizeDataDir(dataDir);
  const roots = legacyBackupRoots().join('\n');
  const hit = legacyEvidenceCache.get(key);
  if (!fresh && hit && hit.roots === roots) return hit.evidence;
  const evidence = scanLegacyUserDataEvidence(dataDir, key);
  legacyEvidenceCache.set(key, { roots, evidence });
  return evidence;
}

// Per-process legacy-evidence lookup for plain reads (a fresh install with a
// missing config would otherwise rescan the legacy root on every read). RMW
// writes always rescan; this process's own backups invalidate it.
const legacyEvidenceCache = new Map();

function scanLegacyUserDataEvidence(dataDir, key) {
  if (backupDirsNewestFirst(scopeDirFor(dataDir)).length > 0) return null;
  const markers = [];
  const backups = [];
  for (const root of legacyBackupRoots()) {
    markers.push(...legacyMarkersFor(root, dataDir, key));
    for (const name of backupDirsNewestFirst(root)) {
      if (name.startsWith(SCOPE_PREFIX)) continue;
      if (manifestDataDirMatches(join(root, name), key)) backups.push(join(root, name));
    }
  }
  backups.sort((x, y) => basename(y).localeCompare(basename(x)));
  return markers.length || backups.length ? { markers, backups, roots: legacyBackupRoots() } : null;
}

/** A missing config is a loss to recover (not a fresh install). */
export function isUserDataRecoveryExpected(dataDir, options) {
  return hasUserDataInitMarker(dataDir) || findLegacyUserDataEvidence(dataDir, options) != null;
}

/** Skip single-section wipe remnants (e.g. `{ search: … }` only). */
function isStructurallyCompleteMixdogConfigBackup(parsed) {
  if (!isPlainObject(parsed)) return false;
  if (Object.keys(parsed).length <= 1) return false;
  if (!parsed.agent && !parsed.channels) return false;
  return true;
}

/** Backup directory names in `dir`, newest first; empty when unreadable. */
function backupDirsNewestFirst(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function backupDirsNewestFirstAsync(dir) {
  try {
    return (await readdirP(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * A backup is restorable only when its manifest names this data dir and this
 * incarnation of it. Legacy unscoped backups carry no manifest, so they stay
 * on disk but never match.
 */
function readRestorableConfig(backupDir, dataDirKey, instanceId) {
  try {
    const manifest = JSON.parse(readFileSync(join(backupDir, BACKUP_MANIFEST), 'utf8'));
    if (typeof manifest?.dataDir !== 'string' || normalizeDataDir(manifest.dataDir) !== dataDirKey) return null;
    if (manifest.instanceId !== instanceId) return null;
    const parsed = JSON.parse(readFileSync(join(backupDir, 'mixdog-config.json'), 'utf8'));
    return isStructurallyCompleteMixdogConfigBackup(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findRestorableConfig(dataDir, instanceId) {
  const key = normalizeDataDir(dataDir);
  const scopeDir = scopeDirFor(dataDir);
  for (const name of backupDirsNewestFirst(scopeDir)) {
    const parsed = readRestorableConfig(join(scopeDir, name), key, instanceId);
    if (parsed) return parsed;
  }
  const root = getBackupRoot();
  for (const name of backupDirsNewestFirst(root)) {
    if (name.startsWith(SCOPE_PREFIX)) continue;
    const parsed = readRestorableConfig(join(root, name), key, instanceId);
    if (parsed) return parsed;
  }
  return null;
}

// Per-process restore lookup, keyed by data dir. A hit is reused while the
// backup root and the marker's instanceId are unchanged; this process's own
// backups invalidate it.
const restoreLookupCache = new Map();

/**
 * Newest structurally complete mixdog-config.json backed up from THIS data
 * dir (skips degenerate single-section snapshots from a prior failed RMW).
 * Never another data dir's config, and nothing for an uninitialized one.
 */
export function loadLatestMixdogConfigFromBackup(dataDir, options) {
  const instanceId = readInitInstanceId(dataDir);
  if (!instanceId) return loadLegacyMixdogConfigFromBackup(dataDir, options);
  const key = normalizeDataDir(dataDir);
  const root = getBackupRoot();
  let hit = restoreLookupCache.get(key);
  if (!hit || hit.root !== root || hit.instanceId !== instanceId) {
    hit = { root, instanceId, config: findRestorableConfig(dataDir, instanceId) };
    restoreLookupCache.set(key, hit);
  }
  return hit.config ? structuredClone(hit.config) : null;
}

/**
 * Upgraded data dir without the in-dir marker: only an unscoped backup whose
 * manifest names this data dir is verifiable (legacy backups predate
 * instanceIds); manifest-less legacy backups are never restored.
 */
function loadLegacyMixdogConfigFromBackup(dataDir, options) {
  const evidence = findLegacyUserDataEvidence(dataDir, options);
  for (const backupDir of evidence?.backups || []) {
    try {
      const parsed = JSON.parse(readFileSync(join(backupDir, 'mixdog-config.json'), 'utf8'));
      if (isStructurallyCompleteMixdogConfigBackup(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function copyTree(src, dst, copied) {
  const st = statSync(src);
  if (st.isDirectory()) {
    for (const name of readdirSync(src)) {
      copyTree(join(src, name), join(dst, name), copied);
    }
    return;
  }
  if (!st.isFile()) return;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied.push(dst);
}

/** Prune one data dir's scope only; other scopes and legacy entries stay. */
function pruneBackups(scopeDir, keep = 40) {
  for (const name of backupDirsNewestFirst(scopeDir).slice(keep)) {
    try {
      rmSync(join(scopeDir, name), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Create the data dir's init marker unless one exists; returns its instanceId
 * (null when the data dir is gone or unwritable). Never creates the data dir.
 */
export function markUserDataInitialized(dataDir) {
  const existing = readInitInstanceId(dataDir);
  if (existing || !dataDir || !existsSync(dataDir)) return existing;
  try {
    writeFileSync(
      join(dataDir, INIT_MARKER),
      `${JSON.stringify(
        { instanceId: randomUUID(), dataDir: resolve(dataDir), createdAt: new Date().toISOString() },
        null,
        2
      )}\n`,
      // An unreadable marker is replaced; a concurrent creator's valid one wins.
      { encoding: 'utf8', flag: existsSync(join(dataDir, INIT_MARKER)) ? 'w' : 'wx' }
    );
  } catch {}
  return readInitInstanceId(dataDir);
}

const ensuredDataDirs = new Set();

/**
 * Called when a readable config is observed. A data dir that predates the
 * in-dir marker (an upgraded install) gets its marker together with a first
 * scoped snapshot, so a later loss of the config stays recoverable. Once per
 * data dir per process.
 */
export function ensureUserDataInitialized(dataDir) {
  if (!dataDir) return;
  const key = normalizeDataDir(dataDir);
  if (ensuredDataDirs.has(key)) return;
  ensuredDataDirs.add(key);
  if (!hasUserDataInitMarker(dataDir)) backupUserData(dataDir, 'initial-snapshot');
}

function skipBackups() {
  return process.env.MIXDOG_SKIP_USER_DATA_BACKUP === '1' || process.env.MIXDOG_SKIP_USER_DATA_BACKUP === 'true';
}

function backupTarget(scopeDir, reason, names) {
  return join(scopeDir, `${stamp(names)}-${safeReason(reason)}`);
}

// Mark first so the manifest carries this incarnation's instanceId; the
// manifest goes last, so an interrupted copy is never restorable.
function finishBackup(dataDir, backupDir, reason) {
  const instanceId = markUserDataInitialized(dataDir);
  writeFileSync(
    join(backupDir, BACKUP_MANIFEST),
    `${JSON.stringify(
      { dataDir: resolve(dataDir), instanceId, reason, createdAt: new Date().toISOString() },
      null,
      2
    )}\n`,
    'utf8'
  );
  restoreLookupCache.delete(normalizeDataDir(dataDir));
  legacyEvidenceCache.delete(normalizeDataDir(dataDir));
}

export function backupUserData(dataDir, reason = 'snapshot') {
  if (skipBackups()) return { dir: null, copied: [] };
  if (!dataDir || !existsSync(dataDir)) return { dir: null, copied: [] };
  const scopeDir = scopeDirFor(dataDir);
  const backupDir = backupTarget(scopeDir, reason, backupDirsNewestFirst(scopeDir));
  const copied = [];
  for (const rel of USER_DATA_FILES) {
    const src = join(dataDir, rel);
    if (existsSync(src)) copyTree(src, join(backupDir, rel), copied);
  }
  for (const rel of USER_DATA_DIRS) {
    const src = join(dataDir, rel);
    if (existsSync(src)) copyTree(src, join(backupDir, rel), copied);
  }
  if (copied.length > 0) {
    finishBackup(dataDir, backupDir, reason);
    pruneBackups(scopeDir);
    if (process.env.MIXDOG_SETUP_QUIET !== '1') {
      process.stderr.write(`[user-data-backup] ${reason}: copied ${copied.length} file(s) to ${backupDir}\n`);
    }
  }
  return { dir: copied.length > 0 ? backupDir : null, copied };
}

// ── Async backup variant (fs.promises) ──────────────────────────────
// Byte-for-byte the same policy/skip guards/prune behavior as backupUserData,
// but every filesystem op yields via fs.promises so a debounced config flush
// on the UI event loop never blocks on the copy tree or the prune sweep.
async function copyTreeAsync(src, dst, copied) {
  const st = await statP(src);
  if (st.isDirectory()) {
    for (const name of await readdirP(src)) {
      await copyTreeAsync(join(src, name), join(dst, name), copied);
    }
    return;
  }
  if (!st.isFile()) return;
  await mkdirP(dirname(dst), { recursive: true });
  await copyFileP(src, dst);
  copied.push(dst);
}

async function pruneBackupsAsync(scopeDir, keep = 40) {
  const entries = await backupDirsNewestFirstAsync(scopeDir);
  for (const name of entries.slice(keep)) {
    try {
      await rmP(join(scopeDir, name), { recursive: true, force: true });
    } catch {}
  }
}

export async function backupUserDataAsync(dataDir, reason = 'snapshot') {
  if (skipBackups()) return { dir: null, copied: [] };
  if (!dataDir || !existsSync(dataDir)) return { dir: null, copied: [] };
  const scopeDir = scopeDirFor(dataDir);
  const backupDir = backupTarget(scopeDir, reason, await backupDirsNewestFirstAsync(scopeDir));
  const copied = [];
  for (const rel of USER_DATA_FILES) {
    const src = join(dataDir, rel);
    if (existsSync(src)) await copyTreeAsync(src, join(backupDir, rel), copied);
  }
  for (const rel of USER_DATA_DIRS) {
    const src = join(dataDir, rel);
    if (existsSync(src)) await copyTreeAsync(src, join(backupDir, rel), copied);
  }
  if (copied.length > 0) {
    finishBackup(dataDir, backupDir, reason);
    await pruneBackupsAsync(scopeDir);
    if (process.env.MIXDOG_SETUP_QUIET !== '1') {
      process.stderr.write(`[user-data-backup] ${reason}: copied ${copied.length} file(s) to ${backupDir}\n`);
    }
  }
  return { dir: copied.length > 0 ? backupDir : null, copied };
}

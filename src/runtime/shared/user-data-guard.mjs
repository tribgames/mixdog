import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import {
  mkdir as mkdirP,
  readFile as readFileP,
  readdir as readdirP,
  rm as rmP,
  stat as statP,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomicAsync, writeFileAtomicSync, writeJsonAtomicSync } from './atomic-file.mjs';
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

let lastBackupMs = 0;
let backupSeq = 0;

// `<iso-ms>-<10-digit seq>-<reason>`; an older build's name has no sequence.
const BACKUP_NAME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(?:(\d{10})-)?/;

// The newest backup order among `names` (time, then sequence). An older
// build's name sorts after every sequenced name of its millisecond, so its
// sequence counts as unbounded. Names that are no backup's are ignored.
function newestBackupOrder(names) {
  let ms = 0;
  let seq = -1;
  for (const name of names) {
    const match = BACKUP_NAME_RE.exec(name);
    if (!match) continue;
    const time = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    if (!Number.isFinite(time)) continue;
    const order = match[6] === undefined ? Number.POSITIVE_INFINITY : Number(match[6]);
    if (time > ms || (time === ms && order > seq)) {
      ms = time;
      seq = order;
    }
  }
  return { ms, seq };
}

// A name that sorts after every backup in `names`, whichever process wrote
// them and whatever its clock said: the backup a restore picks as the newest
// is then the one written last, and pruning never takes it.
function nextBackupName(names, reason) {
  const newest = newestBackupOrder(names);
  lastBackupMs = Math.max(Date.now(), lastBackupMs, newest.ms);
  if (lastBackupMs === newest.ms) {
    if (newest.seq === Number.POSITIVE_INFINITY) lastBackupMs += 1;
    else backupSeq = Math.max(backupSeq, newest.seq + 1);
  }
  const time = new Date(lastBackupMs).toISOString().replace(/[:.]/g, '-');
  return `${time}-${String(backupSeq++).padStart(10, '0')}-${safeReason(reason)}`;
}

// The scope's backup directory names. A reservation lists the scope first and
// a listing failure throws: an order guessed without it could sort before the
// newest backup.
function scopeBackupNames(entries) {
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

// Claims the next name with an exclusive mkdir (EEXIST retries after it).
// Returns the claimed dir and the scope's names including it, which pruning
// reuses instead of listing the scope again.
function reserveBackupDir(scopeDir, reason) {
  mkdirSync(scopeDir, { recursive: true });
  const names = scopeBackupNames(readdirSync(scopeDir, { withFileTypes: true }));
  for (;;) {
    const name = nextBackupName(names, reason);
    names.push(name);
    try {
      mkdirSync(join(scopeDir, name));
      return { backupDir: join(scopeDir, name), names };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}

async function reserveBackupDirAsync(scopeDir, reason) {
  await mkdirP(scopeDir, { recursive: true });
  const names = scopeBackupNames(await readdirP(scopeDir, { withFileTypes: true }));
  for (;;) {
    const name = nextBackupName(names, reason);
    names.push(name);
    try {
      await mkdirP(join(scopeDir, name));
      return { backupDir: join(scopeDir, name), names };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
}

// The names past the newest `keep`, never the just-written backup.
function backupsToPrune(names, own, keep = 40) {
  return [...names]
    .sort()
    .reverse()
    .slice(keep)
    .filter((name) => name !== own);
}

function safeReason(reason) {
  return (
    String(reason || 'snapshot')
      .replace(/[^a-z0-9_.-]+/gi, '-')
      .slice(0, 48) || 'snapshot'
  );
}

/** instanceId of this data dir's init marker; null only when absent. */
function readInitInstanceId(dataDir) {
  if (!dataDir) return null;
  const path = join(dataDir, INIT_MARKER);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError(`[user-data] invalid initialization marker at ${path}`, { cause: error });
  }
  if (typeof marker?.instanceId !== 'string' || !marker.instanceId) {
    throw new SyntaxError(`[user-data] initialization marker at ${path} must have a non-empty instanceId`);
  }
  return marker.instanceId;
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

// A backup that is absent, not a backup, or not JSON is no backup; any other
// failure (EIO, EACCES, EMFILE…) is transient and must not pass for one.
function isAbsentBackupError(error) {
  return error instanceof SyntaxError || error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

/** Backup directory names in `dir`, newest first; empty when absent, throws on other failures. */
function listBackupDirsNewestFirst(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (isAbsentBackupError(error)) return [];
    throw error;
  }
}

/** Backup directory names in `dir`, newest first; empty when unreadable. */
function backupDirsNewestFirst(dir) {
  try {
    return listBackupDirsNewestFirst(dir);
  } catch {
    return [];
  }
}

/**
 * A backup is restorable only when its manifest names this data dir and this
 * incarnation of it. Legacy unscoped backups carry no manifest, so they stay
 * on disk but never match. A transient read failure throws: skipping the
 * backup would restore an older one instead.
 */
function readRestorableConfig(backupDir, dataDirKey, instanceId) {
  try {
    const manifest = JSON.parse(readFileSync(join(backupDir, BACKUP_MANIFEST), 'utf8'));
    if (typeof manifest?.dataDir !== 'string' || normalizeDataDir(manifest.dataDir) !== dataDirKey) return null;
    if (manifest.instanceId !== instanceId) return null;
    const parsed = JSON.parse(readFileSync(join(backupDir, 'mixdog-config.json'), 'utf8'));
    return isStructurallyCompleteMixdogConfigBackup(parsed) ? parsed : null;
  } catch (error) {
    if (isAbsentBackupError(error)) return null;
    throw error;
  }
}

function findRestorableConfig(dataDir, instanceId) {
  const key = normalizeDataDir(dataDir);
  const scopeDir = scopeDirFor(dataDir);
  for (const name of listBackupDirsNewestFirst(scopeDir)) {
    const parsed = readRestorableConfig(join(scopeDir, name), key, instanceId);
    if (parsed) return parsed;
  }
  const root = getBackupRoot();
  for (const name of listBackupDirsNewestFirst(root)) {
    if (name.startsWith(SCOPE_PREFIX)) continue;
    const parsed = readRestorableConfig(join(root, name), key, instanceId);
    if (parsed) return parsed;
  }
  return null;
}

// Per-process restore lookup, keyed by data dir. A hit is reused while the
// backup root and the marker's instanceId are unchanged; this process's own
// backups invalidate it, and a `fresh` lookup (an RMW write, which another
// process's newer backup may precede) always rescans.
const restoreLookupCache = new Map();

/**
 * Newest structurally complete mixdog-config.json backed up from THIS data
 * dir (skips degenerate single-section snapshots from a prior failed RMW).
 * Never another data dir's config, and nothing for an uninitialized one.
 * Throws on a transient read failure, which is never cached.
 */
export function loadLatestMixdogConfigFromBackup(dataDir, options) {
  const instanceId = readInitInstanceId(dataDir);
  if (!instanceId) return loadLegacyMixdogConfigFromBackup(dataDir, options);
  const key = normalizeDataDir(dataDir);
  const root = getBackupRoot();
  let hit = restoreLookupCache.get(key);
  if (options?.fresh || !hit || hit.root !== root || hit.instanceId !== instanceId) {
    restoreLookupCache.delete(key);
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
  // A copy goes through an fsynced handle: a plain copy can leave a backup that
  // is NUL exactly when a crash makes it needed.
  writeFileAtomicSync(dst, readFileSync(src), { mode: st.mode & 0o777 });
  copied.push(dst);
}

// Only a published manifest makes a backup count toward retention.
const manifestPath = (scopeDir, name) => join(scopeDir, name, BACKUP_MANIFEST);

/** Prune one data dir's scope only; other scopes, legacy entries and
 *  unfinished reservations stay. */
function pruneBackups(scopeDir, names, own) {
  const completed = names.filter((name) => {
    try {
      return statSync(manifestPath(scopeDir, name)).isFile();
    } catch {
      return false;
    }
  });
  for (const name of backupsToPrune(completed, own)) {
    try {
      rmSync(join(scopeDir, name), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Create a missing init marker; return its instanceId, or null if the data dir
 * is gone or the missing marker cannot be created. Never creates the data dir.
 * Read/validation failures throw; an existing marker is never replaced.
 */
export function markUserDataInitialized(dataDir) {
  const existing = readInitInstanceId(dataDir);
  if (existing || !dataDir || !existsSync(dataDir)) return existing;
  try {
    const marker = join(dataDir, INIT_MARKER);
    writeJsonAtomicSync(
      marker,
      { instanceId: randomUUID(), dataDir: resolve(dataDir), createdAt: new Date().toISOString() },
      // Another creator may have published since the absent read; it wins.
      { createOnly: true }
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
  if (!hasUserDataInitMarker(dataDir)) backupUserData(dataDir, 'initial-snapshot');
  ensuredDataDirs.add(key);
}

function skipBackups() {
  return process.env.MIXDOG_SKIP_USER_DATA_BACKUP === '1' || process.env.MIXDOG_SKIP_USER_DATA_BACKUP === 'true';
}

// Mark first so the manifest carries this incarnation's instanceId; the
// manifest goes last, so an interrupted copy is never restorable.
function finishBackup(dataDir, backupDir, reason) {
  const instanceId = markUserDataInitialized(dataDir);
  writeJsonAtomicSync(join(backupDir, BACKUP_MANIFEST), {
    dataDir: resolve(dataDir),
    instanceId,
    reason,
    createdAt: new Date().toISOString(),
  });
  restoreLookupCache.delete(normalizeDataDir(dataDir));
  legacyEvidenceCache.delete(normalizeDataDir(dataDir));
}

/** `dirs`: more data-dir folders this one snapshot also carries (a one-time
 *  migration's, e.g. agents/ and bots/); routine snapshots keep to
 *  USER_DATA_DIRS so the ring stays small. */
export function backupUserData(dataDir, reason = 'snapshot', { dirs = [] } = {}) {
  if (skipBackups()) return { dir: null, copied: [] };
  if (!dataDir || !existsSync(dataDir)) return { dir: null, copied: [] };
  const scopeDir = scopeDirFor(dataDir);
  const { backupDir, names } = reserveBackupDir(scopeDir, reason);
  const copied = [];
  try {
    for (const rel of USER_DATA_FILES) {
      const src = join(dataDir, rel);
      if (existsSync(src)) copyTree(src, join(backupDir, rel), copied);
    }
    for (const rel of [...USER_DATA_DIRS, ...dirs]) {
      const src = join(dataDir, rel);
      if (existsSync(src)) copyTree(src, join(backupDir, rel), copied);
    }
    if (copied.length > 0) finishBackup(dataDir, backupDir, reason);
  } catch (error) {
    // Drop only this call's reservation; a failed cleanup must not mask the cause.
    try {
      rmSync(backupDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }
  if (copied.length > 0) {
    pruneBackups(scopeDir, names, basename(backupDir));
    if (process.env.MIXDOG_SETUP_QUIET !== '1') {
      process.stderr.write(`[user-data-backup] ${reason}: copied ${copied.length} file(s) to ${backupDir}\n`);
    }
  } else {
    rmSync(backupDir, { recursive: true, force: true });
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
  await writeFileAtomicAsync(dst, await readFileP(src), { mode: st.mode & 0o777 });
  copied.push(dst);
}

async function pruneBackupsAsync(scopeDir, names, own) {
  const completed = [];
  for (const name of names) {
    try {
      if ((await statP(manifestPath(scopeDir, name))).isFile()) completed.push(name);
    } catch {}
  }
  for (const name of backupsToPrune(completed, own)) {
    try {
      await rmP(join(scopeDir, name), { recursive: true, force: true });
    } catch {}
  }
}

export async function backupUserDataAsync(dataDir, reason = 'snapshot') {
  if (skipBackups()) return { dir: null, copied: [] };
  if (!dataDir || !existsSync(dataDir)) return { dir: null, copied: [] };
  const scopeDir = scopeDirFor(dataDir);
  const { backupDir, names } = await reserveBackupDirAsync(scopeDir, reason);
  const copied = [];
  try {
    for (const rel of USER_DATA_FILES) {
      const src = join(dataDir, rel);
      if (existsSync(src)) await copyTreeAsync(src, join(backupDir, rel), copied);
    }
    for (const rel of USER_DATA_DIRS) {
      const src = join(dataDir, rel);
      if (existsSync(src)) await copyTreeAsync(src, join(backupDir, rel), copied);
    }
    if (copied.length > 0) finishBackup(dataDir, backupDir, reason);
  } catch (error) {
    try {
      await rmP(backupDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }
  if (copied.length > 0) {
    await pruneBackupsAsync(scopeDir, names, basename(backupDir));
    if (process.env.MIXDOG_SETUP_QUIET !== '1') {
      process.stderr.write(`[user-data-backup] ${reason}: copied ${copied.length} file(s) to ${backupDir}\n`);
    }
  } else {
    rmSync(backupDir, { recursive: true, force: true });
  }
  return { dir: copied.length > 0 ? backupDir : null, copied };
}

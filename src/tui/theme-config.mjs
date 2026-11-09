/*
 * theme-config.mjs — the `ui.theme` the TUI paints its boot in, read the way Node's boot read it.
 *
 * Node's `readConfig()` read mixdog-config.json and, when it was missing or malformed in a data dir that had been
 * initialized, restored the newest structurally complete backup of that data dir (and then wrote it back, and set
 * a malformed file aside). The Rust core has no such restore, so the repair stays with whoever writes the config;
 * the TUI only reads: it picks the theme from the file, or from the backup Node would have restored from, and
 * never writes, renames or backs anything up.
 *
 * Backups: `<backup root>/scope-<sha256(data dir)[0:16]>/<name>/{backup.json,mixdog-config.json}` (newest name
 * first), then the unscoped entries of the root; a backup counts only when its manifest names this data dir and
 * this incarnation (`instanceId` of `.mixdog-user-data.json`). A data dir without that marker is restored only
 * from an unscoped backup whose manifest names it (legacy evidence).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseJsonText } from '../runtime/shared/atomic-file.mjs';
import { mixdogHome, resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

const CONFIG_FILE = 'mixdog-config.json';
const INIT_MARKER = '.mixdog-user-data.json';
const BACKUP_MANIFEST = 'backup.json';
const SCOPE_PREFIX = 'scope-';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const backupRoot = () =>
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT ||
  join(process.env.MIXDOG_HOME || process.env.MIXDOG_CONFIG_DIR || mixdogHome(), 'backups', 'user-data');

function normalizeDataDir(dataDir) {
  const full = resolve(String(dataDir));
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

const scopeDirFor = (dataDir) =>
  join(backupRoot(), `${SCOPE_PREFIX}${createHash('sha256').update(normalizeDataDir(dataDir)).digest('hex').slice(0, 16)}`);

/** instanceId of the data dir's init marker; null when there is none, a throw for a marker that is not one. */
function readInitInstanceId(dataDir) {
  let raw;
  try {
    raw = readFileSync(join(dataDir, INIT_MARKER), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const marker = JSON.parse(raw);
  if (typeof marker?.instanceId !== 'string' || !marker.instanceId) throw new SyntaxError('invalid initialization marker');
  return marker.instanceId;
}

const isAbsentBackupError = (error) => error instanceof SyntaxError || error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

/** Backup directory names, newest first; empty when absent, a throw for any other failure. */
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

function backupDirsNewestFirst(dir) {
  try {
    return listBackupDirsNewestFirst(dir);
  } catch {
    return [];
  }
}

function isStructurallyCompleteConfigBackup(parsed) {
  if (!isRecord(parsed)) return false;
  if (Object.keys(parsed).length <= 1) return false;
  return Boolean(parsed.agent || parsed.channels);
}

function readRestorableConfig(backupDir, dataDirKey, instanceId) {
  try {
    const manifest = JSON.parse(readFileSync(join(backupDir, BACKUP_MANIFEST), 'utf8'));
    if (typeof manifest?.dataDir !== 'string' || normalizeDataDir(manifest.dataDir) !== dataDirKey) return null;
    if (manifest.instanceId !== instanceId) return null;
    const parsed = JSON.parse(readFileSync(join(backupDir, CONFIG_FILE), 'utf8'));
    return isStructurallyCompleteConfigBackup(parsed) ? parsed : null;
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
  const root = backupRoot();
  for (const name of listBackupDirsNewestFirst(root)) {
    if (name.startsWith(SCOPE_PREFIX)) continue;
    const parsed = readRestorableConfig(join(root, name), key, instanceId);
    if (parsed) return parsed;
  }
  return null;
}

/* ── a data dir from before the in-dir marker ─────────────────────────────────────────────────────────── */

function legacyBackupRoots() {
  const legacy =
    process.env.MIXDOG_USER_DATA_BACKUP_ROOT ||
    join(process.env.MIXDOG_CONFIG_DIR || join(homedir(), '.mixdog'), 'backups', 'user-data');
  const current = backupRoot();
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
  return names.filter((name) => {
    if (hashed.has(name)) return true;
    try {
      const marker = JSON.parse(readFileSync(join(root, name), 'utf8'));
      return typeof marker?.dataDir === 'string' && normalizeDataDir(marker.dataDir) === dataDirKey;
    } catch {
      return false;
    }
  });
}

/** Evidence that an older build initialized this (marker-less) data dir; null when there is none or it was migrated. */
function legacyEvidence(dataDir) {
  const key = normalizeDataDir(dataDir);
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
  return markers.length || backups.length ? { backups } : null;
}

/** The config Node's plain read would have restored for a missing or malformed one, or null. */
function restoredConfig(dataDir) {
  const instanceId = readInitInstanceId(dataDir);
  if (instanceId) {
    try {
      return findRestorableConfig(dataDir, instanceId);
    } catch {
      return null; // a transient failure: Node's read stayed empty
    }
  }
  const evidence = legacyEvidence(dataDir);
  if (!evidence) return null;
  for (const backupDir of evidence.backups) {
    try {
      const parsed = JSON.parse(readFileSync(join(backupDir, CONFIG_FILE), 'utf8'));
      if (isStructurallyCompleteConfigBackup(parsed)) return parsed;
    } catch {
      /* the next one */
    }
  }
  return null;
}

/** The stored `ui.theme` (a string) of the config, else of the backup it would be restored from; null when none. */
export function readStoredThemeSetting(dataDir = resolvePluginData()) {
  try {
    let parsed = null;
    try {
      parsed = parseJsonText(readFileSync(join(dataDir, CONFIG_FILE), 'utf8'));
    } catch (error) {
      // A missing file and a malformed one both go to the restore; an unreadable one is an error (default theme).
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const config = parsed != null ? parsed : restoredConfig(dataDir);
    const ui = isRecord(config) ? config.ui : null;
    return isRecord(ui) ? ui.theme : null;
  } catch {
    return null;
  }
}

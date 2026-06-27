import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

function mixdogConfigBaseDir() {
  return process.env.MIXDOG_CONFIG_DIR || join(homedir(), '.mixdog');
}

export function getBackupRoot() {
  return process.env.MIXDOG_USER_DATA_BACKUP_ROOT
    || join(mixdogConfigBaseDir(), 'backups', 'user-data');
}
const RECOVERY_NOTICE = 'RECOVERY-REQUIRED.txt';

const USER_DATA_FILES = [
  'mixdog-config.json',
  'user-workflow.md',
  'history/user.md',
  'history/bot.md',
];

const USER_DATA_DIRS = [
  'schedules',
  'webhooks',
  'workflows',
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeReason(reason) {
  return String(reason || 'snapshot').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 48) || 'snapshot';
}

function initMarkerPath(dataDir) {
  const id = createHash('sha256').update(String(dataDir || 'unknown')).digest('hex').slice(0, 16);
  return join(getBackupRoot(), `.initialized-${id}.json`);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function hasUserDataInitMarker(dataDir) {
  return existsSync(initMarkerPath(dataDir));
}

/** Skip single-section wipe remnants (e.g. `{ search: … }` only). */
export function isStructurallyCompleteMixdogConfigBackup(parsed) {
  if (!isPlainObject(parsed)) return false;
  if (Object.keys(parsed).length <= 1) return false;
  if (!parsed.agent && !parsed.channels) return false;
  return true;
}

/**
 * Newest backup first: return the first structurally complete mixdog-config.json
 * (skips degenerate single-section snapshots from a prior failed RMW).
 */
export function loadLatestMixdogConfigFromBackup(_dataDir) {
  const root = getBackupRoot();
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of entries) {
    const cfgPath = join(root, name, 'mixdog-config.json');
    if (!existsSync(cfgPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (isStructurallyCompleteMixdogConfigBackup(parsed)) return parsed;
    } catch {
      continue;
    }
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

function pruneBackups(keep = 40) {
  let entries = [];
  try {
    entries = readdirSync(getBackupRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return;
  }
  for (const name of entries.slice(keep)) {
    try { rmSync(join(getBackupRoot(), name), { recursive: true, force: true }); } catch {}
  }
}

export function markUserDataInitialized(dataDir) {
  try {
    mkdirSync(getBackupRoot(), { recursive: true });
    writeFileSync(initMarkerPath(dataDir), JSON.stringify({
      dataDir,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf8');
  } catch {}
}

export function backupUserData(dataDir, reason = 'snapshot') {
  if (process.env.MIXDOG_SKIP_USER_DATA_BACKUP === '1' || process.env.MIXDOG_SKIP_USER_DATA_BACKUP === 'true') {
    return { dir: null, copied: [] };
  }
  if (!dataDir || !existsSync(dataDir)) return { dir: null, copied: [] };
  const backupDir = join(getBackupRoot(), `${stamp()}-${safeReason(reason)}`);
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
    markUserDataInitialized(dataDir);
    pruneBackups();
    if (process.env.MIXDOG_SETUP_QUIET !== '1') {
      process.stderr.write(`[user-data-backup] ${reason}: copied ${copied.length} file(s) to ${backupDir}\n`);
    }
  }
  return { dir: copied.length > 0 ? backupDir : null, copied };
}

export function shouldSeedMissingUserData(dataDir, rel) {
  if (!dataDir) return true;
  if (existsSync(join(dataDir, rel))) {
    markUserDataInitialized(dataDir);
    return false;
  }
  const markerPath = initMarkerPath(dataDir);
  if (!existsSync(markerPath)) return true;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, RECOVERY_NOTICE), [
      'Mixdog refused to recreate missing user data from defaults.',
      '',
      `Missing file: ${rel}`,
      `Data dir: ${dataDir}`,
      `Backup root: ${getBackupRoot()}`,
      '',
      'Restore the missing file from backup, or delete the backup marker',
      markerPath,
      'only if this is an intentional fresh reset.',
      '',
    ].join('\n'), 'utf8');
  } catch {}
  process.stderr.write(`[seed-guard] refused default seed for missing ${rel}; restore from ${getBackupRoot()} or intentionally reset marker\n`);
  return false;
}

// Subdir name this code OWNS and may freely create/install/delete inside.
const OWNED_SUBDIR = '.deps';

// On Windows the filesystem is case-insensitive, so path comparisons must be
// case-folded to stop variants like '.../Data/.deps' from bypassing the
// target===root / dirname===root equality checks.
const CASE_INSENSITIVE = process.platform === 'win32';

function normCase(p) {
  return CASE_INSENSITIVE ? String(p).toLowerCase() : String(p);
}

/**
 * Hard guard: throws unless `targetDir` is EXACTLY the owned subdir directly
 * under the user-data root (`<dataDir>/<ownedSubdir>`). Every other path under
 * the data root is refused — including the root itself, sentinel dirs, and
 * arbitrary subdirs. Call BEFORE any `bun install` / recursive delete.
 *
 * @param {string} targetDir      directory a destructive op is about to touch
 * @param {string} dataDir        the user-data root to protect
 * @param {string} [op]           label for the error message
 * @param {string} [ownedSubdir]  the single owned subdir name (default '.deps')
 * @returns {string}              the resolved owned path (only on allow)
 */
export function assertSafeOwnedDir(targetDir, dataDir, op = 'destructive op', ownedSubdir = OWNED_SUBDIR) {
  if (!targetDir) throw new Error(`[data-guard] ${op} refused: empty target dir`);
  if (!dataDir) throw new Error(`[data-guard] ${op} refused: empty data dir`);

  // STRICT WHITELIST: the ONLY path this code may touch is the exact owned
  // subdir directly under the data root (`<dataDir>/<ownedSubdir>`). Every
  // other path — under the data root OR anywhere else on disk — is refused.
  const target = resolve(targetDir);
  const allowed = resolve(join(dataDir, ownedSubdir));

  if (normCase(target) === normCase(allowed)) {
    return target;
  }

  throw new Error(
    `[data-guard] ${op} refused: ${target} is not the owned dir. ` +
    `Only the exact owned subdir (${allowed}) may be operated on.`
  );
}

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
import {
  copyFile as copyFileP,
  mkdir as mkdirP,
  readdir as readdirP,
  rm as rmP,
  stat as statP,
} from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

function mixdogConfigBaseDir() {
  return process.env.MIXDOG_CONFIG_DIR || join(homedir(), '.mixdog');
}

function getBackupRoot() {
  return process.env.MIXDOG_USER_DATA_BACKUP_ROOT
    || join(mixdogConfigBaseDir(), 'backups', 'user-data');
}

const USER_DATA_FILES = [
  'mixdog-config.json',
  'instructions.md',
  'user-workflow.md',
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
function isStructurallyCompleteMixdogConfigBackup(parsed) {
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

async function pruneBackupsAsync(keep = 40) {
  let entries = [];
  try {
    entries = (await readdirP(getBackupRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return;
  }
  for (const name of entries.slice(keep)) {
    try { await rmP(join(getBackupRoot(), name), { recursive: true, force: true }); } catch {}
  }
}

export async function backupUserDataAsync(dataDir, reason = 'snapshot') {
  if (process.env.MIXDOG_SKIP_USER_DATA_BACKUP === '1' || process.env.MIXDOG_SKIP_USER_DATA_BACKUP === 'true') {
    return { dir: null, copied: [] };
  }
  if (!dataDir || !existsSync(dataDir)) return { dir: null, copied: [] };
  const backupDir = join(getBackupRoot(), `${stamp()}-${safeReason(reason)}`);
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
    markUserDataInitialized(dataDir);
    await pruneBackupsAsync();
    if (process.env.MIXDOG_SETUP_QUIET !== '1') {
      process.stderr.write(`[user-data-backup] ${reason}: copied ${copied.length} file(s) to ${backupDir}\n`);
    }
  }
  return { dir: copied.length > 0 ? backupDir : null, copied };
}

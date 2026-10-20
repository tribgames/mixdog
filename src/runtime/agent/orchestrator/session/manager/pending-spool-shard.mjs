// Per-session pending spool shards: the locked read-modify-write every
// mutation goes through, plus the one-time migration of the pre-sharding
// global spool file. Kept free of the queue machinery so the TUI steering
// mirror shares it without loading the runtime queue.
import { readFile, rename, stat, unlink } from 'node:fs/promises';
import { updateJsonAtomic, withFileLock } from '../../../../shared/atomic-file.mjs';
import { legacyPendingMessagesPath, pendingMessagesPath, PENDING_MESSAGES_MODE } from './pending-spool-path.mjs';

const SHARD_KEY_RE = /^[A-Za-z0-9_-]+$/;
const MIGRATION_LOCK_TIMEOUT_MS = 15_000;

export function isShardKey(key) {
  return typeof key === 'string' && SHARD_KEY_RE.test(key);
}

function storeIsEmpty(store) {
  return (
    Boolean(store) &&
    typeof store === 'object' &&
    (!store.sessions || typeof store.sessions !== 'object' || Object.keys(store.sessions).length === 0)
  );
}

// One shard transaction: locked, compact, durable (queued user messages must
// survive a crash; a damaged shard is kept aside by updateJsonAtomic). A shard emptied by the
// mutation (or found empty) is deleted under the same lock, so the directory
// holds only sessions that actually have queued rows.
async function updateShardFile(key, mutate, extra = null) {
  const path = pendingMessagesPath(key);
  return withFileLock(
    `${path}.lock`,
    async () => {
      const result = await updateJsonAtomic(path, mutate, {
        compact: true,
        lock: true,
        mode: PENDING_MESSAGES_MODE,
        ...extra,
      });
      if (storeIsEmpty(result)) {
        try {
          await unlink(path);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      return result;
    },
    { ...extra }
  );
}

function rowKey(row) {
  return row && typeof row === 'object' && typeof row.id === 'string' && row.id
    ? `id:${row.id}`
    : `json:${JSON.stringify(row)}`;
}

// Idempotent merge of one legacy bucket into its shard: legacy rows (older)
// first, then whatever the shard already holds; rows already present by id are
// not duplicated, so a re-run after a crash changes nothing.
function mergeLegacyBucket(key, legacyRows, legacyTouchedAt) {
  return (raw) => {
    const current = Array.isArray(raw?.sessions?.[key]) ? raw.sessions[key] : [];
    const present = new Set(current.map(rowKey));
    const additions = legacyRows.filter((row) => !present.has(rowKey(row)));
    if (additions.length === 0) return undefined;
    const now = Date.now();
    const currentTouched = Number(raw?.sessionTouchedAt?.[key]) || 0;
    return {
      version: 1,
      updatedAt: now,
      sessions: { [key]: [...additions, ...current] },
      sessionTouchedAt: { [key]: currentTouched || legacyTouchedAt || now },
    };
  };
}

async function migrateLegacySpool() {
  const legacyPath = legacyPendingMessagesPath();
  try {
    await stat(legacyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  // Every process migrates under the legacy file's own lock, so exactly one
  // performs the merge and the rest find the file already renamed away. The
  // shard locks are only taken inside it (shard operations never take the
  // legacy lock), so there is no lock-order cycle. The backup rename is the
  // commit point: a crash before it re-runs the (idempotent) merge.
  await withFileLock(
    `${legacyPath}.lock`,
    async () => {
      let text;
      try {
        text = await readFile(legacyPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Unreadable content cannot be migrated; keep it as the backup.
      }
      const sessions = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {};
      for (const [key, rows] of Object.entries(sessions)) {
        if (!isShardKey(key) || !Array.isArray(rows) || rows.length === 0) continue;
        const touched = Number(parsed.sessionTouchedAt?.[key]) || Number(parsed.updatedAt) || 0;
        await updateShardFile(key, mergeLegacyBucket(key, rows, touched), { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS });
      }
      await rename(legacyPath, `${legacyPath}.migrated-${Date.now()}-${process.pid}.bak`);
    },
    { timeoutMs: MIGRATION_LOCK_TIMEOUT_MS }
  );
}

let migration = null;

// Resolves once this process has seen the legacy spool migrated (or absent).
// A failure is not memoized: the next shard operation retries it.
export function ensurePendingSpoolMigrated() {
  if (!migration) {
    migration = migrateLegacySpool().catch((error) => {
      migration = null;
      throw error;
    });
  }
  return migration;
}

// TEST-ONLY: forget that this process already migrated (temp data dirs change).
export function _resetPendingSpoolMigrationForTest() {
  migration = null;
}

export async function updatePendingShard(key, mutate, extra = null) {
  await ensurePendingSpoolMigrated();
  return updateShardFile(key, mutate, extra);
}

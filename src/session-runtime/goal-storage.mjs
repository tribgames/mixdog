import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';
import { clean } from '../runtime/shared/clean.mjs';
import {
  DEFAULT_COMPLETED_GOAL_TTL_MS,
  GOAL_FILE_VERSION,
  SESSION_ID,
  assertSessionId,
  completedGoalExpired,
  normalizeStoredGoal,
  publicGoal,
} from './goal-state.mjs';

function goalFilePath(dataDir, sessionId) {
  return join(clean(dataDir) || process.cwd(), 'goals', `${assertSessionId(sessionId)}.json`);
}

export function deleteStoredGoalFile(dataDir, sessionId) {
  try {
    rmSync(goalFilePath(dataDir, sessionId), { force: true });
    return true;
  } catch {
    return false;
  }
}

function readStoredGoalFile(dataDir, sessionId, at = Date.now()) {
  const id = assertSessionId(sessionId);
  try {
    return readGoalRecordFile(goalFilePath(dataDir, id), id, normalizeStoredGoal, at).goal;
  } catch (error) {
    reportGoalStorageError(error);
    return null;
  }
}

export function readStoredGoalSnapshot({
  dataDir,
  sessionId,
  now = () => Date.now(),
  completedGoalTtlMs = DEFAULT_COMPLETED_GOAL_TTL_MS,
} = {}) {
  const at = Math.max(0, Number(now()) || Date.now());
  const goal = publicGoal(readStoredGoalFile(dataDir, sessionId, at), at);
  if (completedGoalExpired(goal, at, completedGoalTtlMs)) {
    deleteStoredGoalFile(dataDir, sessionId);
    return null;
  }
  return goal?.archivedAt ? null : goal;
}

export function listStoredActiveGoalSessionIds({
  dataDir,
  now = () => Date.now(),
  completedGoalTtlMs = DEFAULT_COMPLETED_GOAL_TTL_MS,
} = {}) {
  const root = join(clean(dataDir) || process.cwd(), 'goals');
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const at = Math.max(0, Number(now()) || Date.now());
  const sessionIds = [];
  for (const entry of entries) {
    if (!entry?.isFile?.() || !entry.name.endsWith('.json')) continue;
    const sessionId = entry.name.slice(0, -'.json'.length);
    if (!SESSION_ID.test(sessionId)) continue;
    const goal = publicGoal(readStoredGoalFile(dataDir, sessionId, at), at);
    if (completedGoalExpired(goal, at, completedGoalTtlMs)) {
      deleteStoredGoalFile(dataDir, sessionId);
      continue;
    }
    if (goal?.status === 'active' && !goal.archivedAt) sessionIds.push(sessionId);
  }
  return sessionIds.sort();
}

export function reportGoalStorageError(error) {
  process.emitWarning(error?.message || String(error), { code: 'GOAL_STORAGE_ERROR' });
}

export function readGoalRecordFile(path, sessionId, normalizeGoal, at) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: GOAL_FILE_VERSION, goal: null };
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'goal') || parsed.version !== GOAL_FILE_VERSION) {
      throw new Error('unsupported or invalid Goal record');
    }
    if (parsed.goal !== null && (typeof parsed.goal !== 'object' || Array.isArray(parsed.goal))) throw new Error('invalid Goal value');
    return { version: GOAL_FILE_VERSION, goal: normalizeGoal(parsed.goal, sessionId, at) };
  } catch (cause) {
    throw new Error(`cannot read Goal record ${path}: ${cause.message}; original file preserved, repair or explicitly clear it before creating a Goal`, { cause });
  }
}

// A stat/read refused while the file is being replaced (Windows rename over
// an open handle) or momentarily locked. The committed cache still holds the
// last durable record, which is the right answer for a read that lands inside
// another writer's critical section.
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Cached records are committed snapshots, never mutable working copies.
// Publish only after the atomic writer succeeds; failed writes leave both
// observers and later mutations on the last durable state.
export function createGoalStorage({ pathFor, normalizeGoal, now, writeRecord = writeJsonAtomicAsync }) {
  const cache = new Map();
  const writing = new Set();
  const read = (id) => {
    const cached = cache.get(id);
    // Our own write is in flight: the file is mid-replace, and the cache is
    // the committed state until that write lands. Do not touch the disk.
    if (cached && writing.has(id)) return structuredClone(cached.record);
    const path = pathFor(id);
    let stamp = null;
    try {
      const stat = statSync(path, { bigint: true });
      // Atomic replacements may preserve mtime and size. File identity and
      // change time distinguish them without treating an epoch mtime as absent.
      stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (cached && TRANSIENT_READ_CODES.has(error?.code)) return structuredClone(cached.record);
      if (error?.code !== 'ENOENT') throw error;
    }
    if (cached && stamp !== null && cached.stamp === stamp) return structuredClone(cached.record);
    let record;
    try {
      record = readGoalRecordFile(path, id, normalizeGoal, now());
    } catch (error) {
      if (cached && TRANSIENT_READ_CODES.has(error?.cause?.code ?? error?.code)) {
        return structuredClone(cached.record);
      }
      throw error;
    }
    cache.set(id, { record, stamp });
    return structuredClone(record);
  };
  return {
    read,
    forget(id) { cache.delete(id); },
    async write(id, record) {
      const snapshot = structuredClone(record);
      writing.add(id);
      try {
        await writeRecord(pathFor(id), snapshot, { lock: true, secret: true, fsync: false, timeoutMs: 2_000 });
        // The write lock has already been released. A subsequent stat could
        // belong to another writer, so validate the file on the next read.
        cache.set(id, { record: snapshot, stamp: null });
      } finally {
        writing.delete(id);
      }
    },
  };
}

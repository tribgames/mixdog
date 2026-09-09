import { readFileSync, statSync } from 'node:fs';
import { writeJsonAtomicAsync } from '../runtime/shared/atomic-file.mjs';

export function reportGoalStorageError(error) {
  process.emitWarning(error?.message || String(error), { code: 'GOAL_STORAGE_ERROR' });
}

export function readGoalRecordFile(path, sessionId, normalizeGoal, at) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, goal: null };
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'goal') || parsed.version !== 1) {
      throw new Error('unsupported or invalid Goal record');
    }
    if (parsed.goal !== null && (typeof parsed.goal !== 'object' || Array.isArray(parsed.goal))) throw new Error('invalid Goal value');
    return { version: 1, goal: normalizeGoal(parsed.goal, sessionId, at) };
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
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (error) {
      if (cached && TRANSIENT_READ_CODES.has(error?.code)) return structuredClone(cached.record);
      if (error?.code !== 'ENOENT') throw error;
    }
    if (cached && cached.mtimeMs === mtimeMs) return structuredClone(cached.record);
    let record;
    try {
      record = readGoalRecordFile(path, id, normalizeGoal, now());
    } catch (error) {
      if (cached && TRANSIENT_READ_CODES.has(error?.cause?.code ?? error?.code)) {
        return structuredClone(cached.record);
      }
      throw error;
    }
    cache.set(id, { record, mtimeMs });
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
        let mtimeMs = 0;
        try { mtimeMs = statSync(pathFor(id)).mtimeMs; } catch {}
        cache.set(id, { record: snapshot, mtimeMs });
      } finally {
        writing.delete(id);
      }
    },
  };
}

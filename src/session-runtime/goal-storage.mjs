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

// Cached records are committed snapshots, never mutable working copies.
// Publish only after the atomic writer succeeds; failed writes leave both
// observers and later mutations on the last durable state.
export function createGoalStorage({ pathFor, normalizeGoal, now, writeRecord = writeJsonAtomicAsync }) {
  const cache = new Map();
  const writing = new Set();
  const read = (id) => {
    const path = pathFor(id);
    let mtimeMs = 0;
    try { mtimeMs = statSync(path).mtimeMs; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const cached = cache.get(id);
    if (cached && (writing.has(id) || cached.mtimeMs === mtimeMs)) return structuredClone(cached.record);
    const record = readGoalRecordFile(path, id, normalizeGoal, now());
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

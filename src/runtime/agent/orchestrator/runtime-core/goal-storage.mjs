import { readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseJsonText,
  readJsonStateSync,
  unsupportedState,
  withFileLock,
  writeJsonAtomicAsync,
} from '../../../shared/atomic-file.mjs';
import { clean } from '../../../shared/clean.mjs';
import { runtimeAsyncLocalStorage } from '../../../shared/root-async-context.mjs';
import { createWatchedFileCache, fileStampSync, forgetWatchedFile } from '../../../shared/watched-file-cache.mjs';
import {
  DEFAULT_COMPLETED_GOAL_TTL_MS,
  GOAL_FILE_VERSION,
  SESSION_ID,
  assertSessionId,
  completedGoalExpired,
  freezeUnobservedSegment,
  normalizeStoredGoal,
  publicGoal,
} from './goal-state.mjs';

/** Directory holding one Goal record per session under `dataDir`. */
export function goalsRoot(dataDir) {
  return join(clean(dataDir) || process.cwd(), 'goals');
}

function goalFilePath(dataDir, sessionId) {
  return join(goalsRoot(dataDir), `${assertSessionId(sessionId)}.json`);
}

export function deleteStoredGoalFile(dataDir, sessionId) {
  const path = goalFilePath(dataDir, sessionId);
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    // Same-process changes are immediate: no cached copy outlives the file.
    forgetWatchedFile(path);
  }
}

function readStoredGoalFile(dataDir, sessionId, at = Date.now()) {
  const id = assertSessionId(sessionId);
  try {
    const goal = readGoalRecordFile(goalFilePath(dataDir, id), id, normalizeStoredGoal, at).goal;
    freezeUnobservedSegment(goal);
    return goal;
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
  const root = goalsRoot(dataDir);
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

// A damaged record (empty, NUL, torn, invalid) never blocks the Goal
// feature: readJsonStateSync keeps its bytes aside as `<file>.corrupt-<ts>`,
// restores the last good `.bak` when there is one, else the session has no
// Goal. A record from a newer build is left in place and reads as no Goal.
// Real I/O errors still throw.
function readGoalRecordFile(path, sessionId, normalizeGoal, at) {
  const record = readJsonStateSync(path, {
    secret: true,
    fallback: null,
    validate(parsed) {
      if (Number.isSafeInteger(parsed?.version) && parsed.version > GOAL_FILE_VERSION) {
        throw unsupportedState(`Goal record version ${parsed.version} is newer than this build`);
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !Object.hasOwn(parsed, 'goal') ||
        parsed.version !== GOAL_FILE_VERSION
      ) {
        throw new Error('unsupported or invalid Goal record');
      }
      if (parsed.goal !== null && (typeof parsed.goal !== 'object' || Array.isArray(parsed.goal)))
        throw new Error('invalid Goal value');
      return { version: GOAL_FILE_VERSION, goal: normalizeGoal(parsed.goal, sessionId, at) };
    },
  });
  return record ?? { version: GOAL_FILE_VERSION, goal: null };
}

// A record written by a newer build reads as no Goal and stays in place; a
// write must not replace it (nor, through `.bak`, its backup). Caller holds the
// record's lock. Unreadable or unparsable content is damage, not a newer build.
async function refuseNewerRecord(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  let parsed;
  try {
    parsed = parseJsonText(text);
  } catch {
    return;
  }
  if (Number.isSafeInteger(parsed?.version) && parsed.version > GOAL_FILE_VERSION) {
    throw Object.assign(
      new Error(
        `Goal record ${path} was written by a newer build (version ${parsed.version} > ${GOAL_FILE_VERSION}); update Mixdog to change this Goal`
      ),
      { code: 'EGOALNEWERVERSION' }
    );
  }
}

// A stat/read refused while the file is being replaced (Windows rename over
// an open handle) or momentarily locked. The committed cache still holds the
// last durable record, which is the right answer for a read that lands inside
// another writer's critical section.
const TRANSIENT_READ_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// `{ id, active }`: the session whose read-modify-write runs in this async context.
const mutating = runtimeAsyncLocalStorage();

// Cached records are committed snapshots, never mutable working copies.
// Publish only after the atomic writer succeeds; failed writes leave both
// observers and later mutations on the last durable state.
// Observation reads come from memory (watched-file-cache.mjs); only a change
// by another process, seen by the directory watch or the safety re-check,
// reloads. A mutation (`mutate`) holds the record's lock throughout and reads
// the disk, so it never modifies a snapshot another writer has replaced.
export function createGoalStorage({ pathFor, normalizeGoal, now, writeRecord = writeJsonAtomicAsync }) {
  const writing = new Set();
  const ids = new Map();
  const cache = createWatchedFileCache((path) => {
    const stamp = fileStampSync(path);
    return { stamp, value: readGoalRecordFile(path, ids.get(path), normalizeGoal, now()) };
  });
  const read = (id) => {
    const path = pathFor(id);
    const cached = cache.peek(path);
    // Our own write is in flight: the file is mid-replace, and the cache is
    // the committed state until that write lands. Do not touch the disk.
    if (cached && writing.has(id)) return structuredClone(cached);
    ids.set(path, id);
    const scope = mutating.getStore();
    if (scope?.active && scope.id === id) return structuredClone(cache.get(path, { fresh: true }));
    try {
      return structuredClone(cache.get(path));
    } catch (error) {
      if (cached && TRANSIENT_READ_CODES.has(error?.code)) return structuredClone(cached);
      throw error;
    }
  };
  return {
    read,
    /** Run a read-modify-write of `id`'s record under its lock; its reads
     *  inside come from disk, and its writes re-enter the lock. */
    mutate(id, operation) {
      // Timers armed inside keep this context; once it ends they read as observers.
      const scope = { id, active: true };
      return withFileLock(
        `${pathFor(id)}.lock`,
        async () => {
          try {
            return await mutating.run(scope, operation);
          } finally {
            scope.active = false;
          }
        },
        { timeoutMs: 2_000 }
      );
    },
    close() {
      cache.close();
      ids.clear();
    },
    async write(id, record) {
      const snapshot = structuredClone(record);
      writing.add(id);
      try {
        const path = pathFor(id);
        // The newer-build check and the write share one lock hold, so nothing
        // can publish a newer record between them. The writer's own lock
        // request re-enters this hold.
        await withFileLock(
          `${path}.lock`,
          async () => {
            await refuseNewerRecord(path);
            // Durable, with the replaced version kept as `.bak` for damage recovery.
            await writeRecord(path, snapshot, { lock: true, secret: true, backup: true, timeoutMs: 2_000 });
          },
          { timeoutMs: 2_000 }
        );
        // Visible at once. No stamp: a stat now could belong to another
        // writer, so the next watch event or re-check reloads the file once.
        cache.set(path, snapshot);
      } finally {
        writing.delete(id);
      }
    },
  };
}

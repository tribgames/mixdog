// Durable turn-snapshot index.
//
// The shadow repository already writes every turn baseline to disk as a Git
// tree object, but the map from a session to that tree lived only in runtime
// memory. Beginning the next turn, evicting the 32-entry turn cache or
// restarting the daemon therefore stripped a finished review of its revert
// source while the tree itself was still sitting on disk (user: 실행취소는 왜
// 안 먹는거).
//
// Persist the three values a revert actually needs — the worktree root, the
// baseline tree hash, and the paths this session itself mutated — so a review
// stays revertible for as long as the objects survive. The session-owned path
// list is what lets a SHARED worktree still revert: the baseline describes the
// whole tree, but only these paths may be restored from it.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same resolution as session-runtime/runtime-paths.mjs. Shared runtime code
// cannot import the session layer, so the rule is repeated instead of inverted.
const DATA_DIR = process.env.MIXDOG_DATA_DIR
  || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
const RECORD_VERSION = 1;
// Matches the shadow repository's own `gc --prune` window: once the tree object
// is collected the record cannot restore anything anyway.
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Enough to cover the reviews a user can still act on; the newest turn wins.
const MAX_TURNS_PER_SESSION = 8;
// A session normally stays in one Project, but cwd changes are valid. Keep one
// cumulative baseline per repository root without letting a long-lived session
// grow this record without bound.
const MAX_SESSION_SCOPES = 8;
// A bounded directory: one file per session, oldest swept first.
const MAX_RECORD_FILES = 512;

let recordRoot = join(DATA_DIR, 'turn-snapshots');
// Per-session write chain. Two turns of one session never race their own file,
// and a read never observes a partially written record (writes land by rename).
const writeChains = new Map();
let sweepDone = false;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function rootKey(value) {
  const root = clean(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function sessionScopes(record) {
  const scopes = [];
  const add = (entry) => {
    const root = clean(entry?.root);
    const baselineTree = clean(entry?.baselineTree);
    if (!root || !baselineTree) return;
    const key = rootKey(root);
    const existing = scopes.find((scope) => rootKey(scope.root) === key);
    const files = (Array.isArray(entry?.toolFiles) ? entry.toolFiles : [])
      .map((value) => clean(value))
      .filter(Boolean);
    if (existing) {
      for (const file of files) existing.toolFiles.add(file);
      existing.updatedAt = Math.max(existing.updatedAt, Number(entry?.updatedAt) || 0);
      return;
    }
    scopes.push({
      root,
      baselineTree,
      toolFiles: new Set(files),
      updatedAt: Number(entry?.updatedAt) || 0,
    });
  };
  const stored = Array.isArray(record?.sessionScopes) ? record.sessionScopes : [];
  if (stored.length > 0) {
    for (const scope of stored) add(scope);
  } else {
    // Upgrade an existing v1 record lazily: its oldest retained turn is the
    // earliest baseline still available for this session and root.
    for (const turn of Array.isArray(record?.turns) ? record.turns : []) add(turn);
  }
  return scopes;
}

function recordPath(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(recordRoot, `${hash}.json`);
}

function chain(sessionId, task) {
  const previous = writeChains.get(sessionId) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(sessionId, next.then(() => undefined, () => undefined));
  return next;
}

async function readRecordFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || parsed.version !== RECORD_VERSION) return null;
    if (!Array.isArray(parsed.turns)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Oldest-first sweep so a long-lived install cannot accumulate records. */
async function sweepRecords() {
  if (sweepDone) return;
  sweepDone = true;
  try {
    const names = await readdir(recordRoot);
    const now = Date.now();
    const kept = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(recordRoot, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > RECORD_TTL_MS) {
          await rm(path, { force: true });
          continue;
        }
        kept.push({ path, mtimeMs: info.mtimeMs });
      } catch { /* a record that cannot be read is not worth keeping */ }
    }
    kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of kept.slice(0, Math.max(0, kept.length - MAX_RECORD_FILES))) {
      await rm(entry.path, { force: true });
    }
  } catch { /* the store is best-effort: a revert falls back to memory */ }
}

/**
 * Fold one turn into a session's record. `generation` identifies the turn, so
 * re-recording the same turn updates it in place rather than appending.
 */
export async function saveTurnSnapshotRecord(sessionId, turn) {
  const id = clean(sessionId);
  const baselineTree = clean(turn?.baselineTree);
  const root = clean(turn?.root);
  if (!id || !baselineTree || !root) return false;
  return await chain(id, async () => {
    try {
      await mkdir(recordRoot, { recursive: true });
      void sweepRecords();
      const path = recordPath(id);
      const existing = await readRecordFile(path);
      const generation = Number(turn?.generation) || 0;
      const turns = (existing?.turns || []).filter((entry) => entry?.generation !== generation);
      const nextTurn = {
        generation,
        checkpointId: clean(turn?.checkpointId),
        root,
        baselineTree,
        // Relative, forward-slashed paths this session's own tools mutated.
        toolFiles: [...new Set((Array.isArray(turn?.toolFiles) ? turn.toolFiles : [])
          .map((value) => clean(value))
          .filter(Boolean))],
        sealed: turn?.sealed === true,
        updatedAt: Date.now(),
      };
      turns.push(nextTurn);
      turns.sort((left, right) => (left.generation || 0) - (right.generation || 0));
      const scopes = sessionScopes(existing);
      const scope = scopes.find((entry) => rootKey(entry.root) === rootKey(root));
      if (scope) {
        for (const file of nextTurn.toolFiles) scope.toolFiles.add(file);
        scope.updatedAt = nextTurn.updatedAt;
      } else {
        scopes.push({
          root,
          baselineTree,
          toolFiles: new Set(nextTurn.toolFiles),
          updatedAt: nextTurn.updatedAt,
        });
      }
      const payload = {
        version: RECORD_VERSION,
        sessionId: id,
        turns: turns.slice(-MAX_TURNS_PER_SESSION),
        sessionScopes: scopes
          .sort((left, right) => left.updatedAt - right.updatedAt)
          .slice(-MAX_SESSION_SCOPES)
          .map((entry) => ({
            root: entry.root,
            baselineTree: entry.baselineTree,
            toolFiles: [...entry.toolFiles],
            updatedAt: entry.updatedAt,
          })),
      };
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(payload), 'utf8');
      await rename(temporary, path);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The newest recorded turn that actually owns files. A turn that mutated
 * nothing has nothing to revert, and returning it would hide the completed
 * turn behind it — which is exactly the review the user is looking at.
 */
export async function loadTurnSnapshotRecord(sessionId) {
  const id = clean(sessionId);
  if (!id) return null;
  const record = await readRecordFile(recordPath(id));
  if (!record) return null;
  for (let index = record.turns.length - 1; index >= 0; index -= 1) {
    const turn = record.turns[index];
    if (!turn?.baselineTree || !turn?.root) continue;
    if (!Array.isArray(turn.toolFiles) || turn.toolFiles.length === 0) continue;
    return turn;
  }
  return null;
}

/** Earliest retained baseline plus every path attributed to this session,
 * grouped by repository root. This is the durable source for the pane's
 * session-wide Diff and is intentionally separate from latest-turn Undo. */
export async function loadSessionSnapshotRecords(sessionId) {
  const id = clean(sessionId);
  if (!id) return [];
  const record = await readRecordFile(recordPath(id));
  if (!record) return [];
  return sessionScopes(record).map((entry) => ({
    root: entry.root,
    baselineTree: entry.baselineTree,
    toolFiles: [...entry.toolFiles],
    updatedAt: entry.updatedAt,
  }));
}

export async function deleteTurnSnapshotRecords(sessionId) {
  const id = clean(sessionId);
  if (!id) return;
  await chain(id, async () => {
    try { await rm(recordPath(id), { force: true }); } catch { /* best effort */ }
  });
}

export function _setTurnSnapshotStoreRootForTest(directory) {
  recordRoot = clean(directory) || join(DATA_DIR, 'turn-snapshots');
  writeChains.clear();
  sweepDone = false;
}

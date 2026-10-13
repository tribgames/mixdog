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
import { join } from 'node:path';
import { cleanString as clean } from './clean.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

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

// Test override; otherwise resolved per call because the pristine-execution
// boundary retargets MIXDOG_DATA_DIR at runtime.
let recordRootOverride = '';
function recordRoot() {
  return recordRootOverride || join(resolvePluginData(), 'turn-snapshots');
}
// Per-session write chain. Two turns of one session never race their own file,
// and a read never observes a partially written record (writes land by rename).
const writeChains = new Map();
let sweepDone = false;

function rootKey(value) {
  const root = clean(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

// Fold a turn's files into an existing scope: session-owned paths keep the
// baseline they first recorded, and every tool-mutated path joins the owned set.
function mergeScopeFiles(scope, baselineFiles, toolFiles) {
  const owned = new Set([...scope.toolFiles].map(rootKey));
  for (const file of baselineFiles) {
    if (!owned.has(rootKey(file.path))) scope.baselineFiles.set(rootKey(file.path), file);
  }
  for (const file of toolFiles) scope.toolFiles.add(file);
}

function sessionScopes(record) {
  const scopes = [];
  const add = (entry) => {
    const root = clean(entry?.root);
    const baselineTree = clean(entry?.baselineTree);
    if (!root || !baselineTree) return;
    const key = rootKey(root);
    const existing = scopes.find((scope) => rootKey(scope.root) === key);
    const files = (Array.isArray(entry?.toolFiles) ? entry.toolFiles : []).map((value) => clean(value)).filter(Boolean);
    const baselineFiles = Array.isArray(entry?.baselineFiles) ? entry.baselineFiles : [];
    if (existing) {
      mergeScopeFiles(existing, baselineFiles, files);
      existing.updatedAt = Math.max(existing.updatedAt, Number(entry?.updatedAt) || 0);
      return;
    }
    scopes.push({
      root,
      baselineTree,
      toolFiles: new Set(files),
      baselineFiles: new Map(baselineFiles.map((file) => [rootKey(file.path), file])),
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

/** Plain-JSON form of a scope built by sessionScopes(). */
function serializeScope(entry) {
  return {
    root: entry.root,
    baselineTree: entry.baselineTree,
    toolFiles: [...entry.toolFiles],
    baselineFiles: [...entry.baselineFiles.values()],
    updatedAt: entry.updatedAt,
  };
}

function recordPath(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(recordRoot(), `${hash}.json`);
}

function chain(sessionId, task) {
  const previous = writeChains.get(sessionId) || Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
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

/** Oldest-first sweep of one record directory so a long-lived install cannot
 *  accumulate records. */
async function sweepDirectory(directory, ttlMs, maxFiles) {
  try {
    const names = await readdir(directory);
    const now = Date.now();
    const kept = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(directory, name);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > ttlMs) {
          await rm(path, { force: true });
          continue;
        }
        kept.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        /* a record that cannot be read is not worth keeping */
      }
    }
    kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of kept.slice(0, Math.max(0, kept.length - maxFiles))) {
      await rm(entry.path, { force: true });
    }
  } catch {
    /* the store is best-effort: a revert falls back to memory */
  }
}

async function sweepRecords() {
  if (sweepDone) return;
  sweepDone = true;
  await sweepDirectory(recordRoot(), RECORD_TTL_MS, MAX_RECORD_FILES);
}

async function writeJsonAtomically(path, payload) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(payload), 'utf8');
  await rename(temporary, path);
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
      await mkdir(recordRoot(), { recursive: true });
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
        baselineFiles: Array.isArray(turn?.baselineFiles) ? turn.baselineFiles : [],
        // Relative, forward-slashed paths this session's own tools mutated.
        toolFiles: [
          ...new Set(
            (Array.isArray(turn?.toolFiles) ? turn.toolFiles : []).map((value) => clean(value)).filter(Boolean)
          ),
        ],
        sealed: turn?.sealed === true,
        updatedAt: Date.now(),
      };
      turns.push(nextTurn);
      turns.sort((left, right) => (left.generation || 0) - (right.generation || 0));
      const scopes = sessionScopes(existing);
      const scope = scopes.find((entry) => rootKey(entry.root) === rootKey(root));
      if (scope) {
        mergeScopeFiles(scope, nextTurn.baselineFiles, nextTurn.toolFiles);
        scope.updatedAt = nextTurn.updatedAt;
      } else {
        scopes.push({
          root,
          baselineTree,
          toolFiles: new Set(nextTurn.toolFiles),
          baselineFiles: new Map(nextTurn.baselineFiles.map((file) => [rootKey(file.path), file])),
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
          .map(serializeScope),
      };
      await writeJsonAtomically(path, payload);
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
  return sessionScopes(record).map(serializeScope);
}

// ── Per-turn change records ─────────────────────────────────────────────────
//
// One file per session holding every retained turn's frozen net diff, keyed by
// checkpointId (the outer prompt id). Unlike the baseline index above these
// carry their own complete patches, so they need no shadow object to survive.

const CHANGES_VERSION = 1;
// Byte budget of one session's change records; the oldest turns go first.
const MAX_CHANGE_BYTES_PER_SESSION = 32 * 1024 * 1024;
const MAX_CHANGE_RECORD_FILES = 512;
const CHANGE_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let changesSweepDone = false;

function changesRoot() {
  return join(recordRoot(), 'changes');
}

function changesPath(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(changesRoot(), `${hash}.json`);
}

async function readChangesFile(sessionId) {
  try {
    const parsed = JSON.parse(await readFile(changesPath(sessionId), 'utf8'));
    if (parsed?.version !== CHANGES_VERSION || parsed.sessionId !== sessionId) return null;
    return Array.isArray(parsed.records) ? parsed : null;
  } catch {
    return null;
  }
}

/** Evict the oldest turns until the session fits its byte budget; a turn that
 *  alone exceeds it drops its largest patches (those files stop being
 *  revertable) instead of the whole record. */
function boundChangeRecords(records, keepCheckpointId) {
  const sizes = records.map((record) => Buffer.byteLength(JSON.stringify(record), 'utf8'));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  for (let index = 0; total > MAX_CHANGE_BYTES_PER_SESSION && index < records.length; ) {
    if (records[index].checkpointId === keepCheckpointId) {
      index += 1;
      continue;
    }
    total -= sizes[index];
    records.splice(index, 1);
    sizes.splice(index, 1);
  }
  if (total <= MAX_CHANGE_BYTES_PER_SESSION) return;
  const kept = records.find((record) => record.checkpointId === keepCheckpointId);
  const largest = (kept?.files || [])
    .filter((file) => typeof file.patch === 'string')
    .sort((left, right) => right.patch.length - left.patch.length);
  for (const file of largest) {
    if (total <= MAX_CHANGE_BYTES_PER_SESSION) break;
    total -= Buffer.byteLength(file.patch, 'utf8');
    file.patch = null;
    delete file.patchEncoding;
    file.revertable = false;
    file.reason = 'change is too large to keep for undo';
    file.patchOmitted = true;
  }
}

// Test seam: runs before every change-record write; a throw fails the write.
let changeWriteHookForTest = null;

async function writeChangeRecords(sessionId, records) {
  await changeWriteHookForTest?.(sessionId, records);
  await mkdir(changesRoot(), { recursive: true });
  if (!changesSweepDone) {
    changesSweepDone = true;
    void sweepDirectory(changesRoot(), CHANGE_RECORD_TTL_MS, MAX_CHANGE_RECORD_FILES);
  }
  await writeJsonAtomically(changesPath(sessionId), { version: CHANGES_VERSION, sessionId, records });
}

const changeContent = (record) => JSON.stringify([record.kind, record.root, record.agents || [], record.files || []]);

/**
 * Upsert one turn's frozen changes. Every file of the new freeze is `applied`;
 * a file the user had already undone and that the new net diff no longer
 * contains keeps its `reverted` entry, so Reapply survives a re-seal. The
 * revision bumps only when the record actually changed. Resolves to the
 * stored record.
 */
export async function upsertTurnChangeRecord(sessionId, next) {
  const id = clean(sessionId);
  const checkpointId = clean(next?.checkpointId);
  if (!id || !checkpointId) return null;
  return await chain(`changes:${id}`, async () => {
    const records = (await readChangesFile(id))?.records || [];
    const index = records.findIndex((record) => record?.checkpointId === checkpointId);
    const prior = index >= 0 ? records[index] : null;
    const files = (Array.isArray(next.files) ? next.files : []).map((file) => ({ ...file, state: 'applied' }));
    const present = new Set(files.map((file) => rootKey(file.path)));
    for (const file of prior?.files || []) {
      if (file.state === 'reverted' && !present.has(rootKey(file.path))) files.push(file);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const candidate = {
      checkpointId,
      kind: clean(next.kind) || 'git',
      root: clean(next.root),
      agents: Array.isArray(next.agents) ? next.agents : [],
      files,
    };
    if (prior && changeContent(prior) === changeContent(candidate)) return prior;
    const now = Date.now();
    const record = {
      ...candidate,
      revision: (Number(prior?.revision) || 0) + 1,
      createdAt: Number(prior?.createdAt) || now,
      updatedAt: now,
    };
    if (index >= 0) records[index] = record;
    else records.push(record);
    boundChangeRecords(records, checkpointId);
    await writeChangeRecords(id, records);
    return records.find((entry) => entry.checkpointId === checkpointId) || null;
  });
}

/** Apply `mutate(record)` (returning the next files, or null for no change)
 *  and bump the revision. Serialized with every other write of the session. */
export async function updateTurnChangeRecord(sessionId, checkpointId, mutate) {
  const id = clean(sessionId);
  const key = clean(checkpointId);
  if (!id || !key) return null;
  return await chain(`changes:${id}`, async () => {
    const records = (await readChangesFile(id))?.records || [];
    const index = records.findIndex((record) => record?.checkpointId === key);
    if (index < 0) return null;
    const files = mutate(records[index]);
    if (!files) return records[index];
    records[index] = {
      ...records[index],
      files,
      revision: (Number(records[index].revision) || 0) + 1,
      updatedAt: Date.now(),
    };
    await writeChangeRecords(id, records);
    return records[index];
  });
}

/** One turn's change record by its exact checkpoint id; never a fallback. */
export async function loadTurnChangeRecord(sessionId, checkpointId) {
  const id = clean(sessionId);
  const key = clean(checkpointId);
  if (!id || !key) return null;
  const records = (await readChangesFile(id))?.records || [];
  return records.find((record) => record?.checkpointId === key) || null;
}

export function _setTurnChangeRecordWriteHookForTest(hook) {
  changeWriteHookForTest = typeof hook === 'function' ? hook : null;
}

export function _setTurnSnapshotStoreRootForTest(directory) {
  recordRootOverride = clean(directory);
  writeChains.clear();
  sweepDone = false;
  changesSweepDone = false;
}

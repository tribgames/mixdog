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
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomicAsync } from './atomic-file.mjs';
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

/** The directory every turn-snapshot store lives under (follows the test
 *  override and a runtime MIXDOG_DATA_DIR retarget). */
export function turnSnapshotStoreRoot() {
  return recordRoot();
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
export async function sweepDirectory(directory, ttlMs, maxFiles) {
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

// Flushed before it is published: a crash must not leave a record that reads as
// NUL (every reader below answers a damaged record as "no record").
async function writeJsonAtomically(path, payload) {
  await writeFileAtomicAsync(path, JSON.stringify(payload));
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
      await endClearedHistory(id);
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

/** The review summary an earlier version cached per session (files and
 *  counts of its last recorded review). Nothing writes it any more; deleting
 *  a session's history still removes one left behind. */
function legacySummaryPath(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(recordRoot(), 'review-summaries', `${hash}.json`);
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

/**
 * Permanently delete one session's retained change history: its turn
 * baselines and session scopes, and every per-turn change record (stored
 * patches, file metadata, applied/reverted state). The baseline index keeps a
 * `historyCleared` marker so the session review answers an authoritative
 * empty set instead of falling back to older sources; the next recorded turn
 * starts a fresh scope. Each half is serialized with the other writes of its
 * file. Resolves to the number of turn change records deleted.
 */
export async function clearSessionChangeHistory(sessionId) {
  const id = clean(sessionId);
  if (!id) return 0;
  await chain(id, async () => {
    // The marker lands before the records go: a failure in between leaves
    // the session answering empty, never resurrecting what was asked gone.
    await mkdir(clearedRoot(), { recursive: true });
    await writeJsonAtomically(clearedPath(id), { version: RECORD_VERSION, sessionId: id, clearedAt: Date.now() });
    await rm(legacySummaryPath(id), { force: true });
    await rm(recordPath(id), { force: true });
  });
  return await chain(`changes:${id}`, async () => {
    const records = (await readChangesFile(id))?.records || [];
    await rm(changesPath(id), { force: true });
    changeRecordsCache.delete(id);
    return records.length;
  });
}

// "History deleted" markers live in their own directory: neither record
// sweep (age or count) reaches it, so a deletion stays in force for as long
// as the session exists. The next recorded turn ends it, and deleting the
// session removes it (forgetSessionChangeHistoryMarker).
function clearedRoot() {
  return join(recordRoot(), 'cleared');
}

function clearedPath(sessionId) {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(clearedRoot(), `${hash}.json`);
}

/** End the cleared state: a new turn record of the session was written. */
async function endClearedHistory(sessionId) {
  await rm(clearedPath(sessionId), { force: true });
}

/** The session's history was deleted and no turn has been recorded since. */
export async function sessionChangeHistoryCleared(sessionId) {
  const id = clean(sessionId);
  if (!id) return false;
  try {
    return JSON.parse(await readFile(clearedPath(id), 'utf8'))?.sessionId === id;
  } catch {
    return false;
  }
}

/** The session itself was deleted: its history marker goes with it. */
export async function forgetSessionChangeHistoryMarker(sessionId) {
  const id = clean(sessionId);
  if (!id) return;
  await chain(id, () => rm(clearedPath(id), { force: true })).catch(() => {});
}

// Absolute, slash-normalized and (on Windows) case-folded: equal for every
// spelling of one folder, so a stored root and a caller's root compare equal.
function matchKey(value) {
  const text = clean(value);
  if (!text) return '';
  const key = resolve(text).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/**
 * Remove one worktree root from every session record: its turns and its
 * session scope. Other roots' scopes, turns and the rest of the session history
 * stay; a record left with nothing is deleted. Serialized with saves through
 * the per-session chain. The per-turn change records rooted there are marked
 * unavailable (see forgetChangeRecordsRoot). Returns `{ removed, kept }`:
 * removed are `<recordFile>#<root>` scopes (or the record file itself once
 * emptied) and `<changesFile>#<checkpointId>` change records; kept are files
 * that matched but could not be rewritten.
 */
export async function forgetTurnSnapshotRoot(root) {
  const removed = [];
  const kept = [];
  const target = matchKey(root);
  if (!target) return { removed, kept };
  let names = [];
  try {
    names = await readdir(recordRoot());
  } catch {
    return { removed, kept };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(recordRoot(), name);
    const sessionId = clean((await readRecordFile(path))?.sessionId);
    if (!sessionId) continue;
    await chain(sessionId, async () => {
      const record = await readRecordFile(path);
      if (!record) return;
      const turns = record.turns.filter((turn) => matchKey(turn?.root) !== target);
      const scopes = sessionScopes(record);
      const remaining = scopes.filter((scope) => matchKey(scope.root) !== target);
      if (turns.length === record.turns.length && remaining.length === scopes.length) return;
      try {
        if (turns.length === 0 && remaining.length === 0) {
          await rm(path, { force: true });
          removed.push(path);
          return;
        }
        await writeJsonAtomically(path, { ...record, turns, sessionScopes: remaining.map(serializeScope) });
        removed.push(`${path}#${target}`);
      } catch {
        kept.push(path);
      }
    });
  }
  await forgetChangeRecordsRoot(target, removed, kept);
  return { removed, kept };
}

/** Why a change-record file of a removed worktree can no longer be undone or
 *  reapplied. */
export const REMOVED_WORKTREE_CHANGE_REASON = 'its worktree was removed';

const unavailableChangeFile = (file) => {
  const { patch, patchEncoding, patchOmitted, ...rest } = file;
  return { ...rest, revertable: false, reason: REMOVED_WORKTREE_CHANGE_REASON, patch: null };
};

const changeFileUnavailable = (file) =>
  file.revertable === false && file.reason === REMOVED_WORKTREE_CHANGE_REASON && file.patch === null;

/**
 * Mark every per-turn change record rooted at `target` (a matchKey) as
 * unavailable: the record and its file list stay, so the turn's history card
 * still says what changed, but each file drops its patch (the removed
 * worktree's contents) and becomes non-revertable, so no Undo or Reapply is
 * offered. Records of other roots are untouched. Serialized with every other
 * change-record write of the session.
 */
async function forgetChangeRecordsRoot(target, removed, kept) {
  let names = [];
  try {
    names = await readdir(changesRoot());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(changesRoot(), name);
    let sessionId = '';
    try {
      sessionId = clean(JSON.parse(await readFile(path, 'utf8'))?.sessionId);
    } catch {
      // Unreadable or corrupt file: no session id, skipped below.
    }
    if (!sessionId || changesPath(sessionId) !== path) continue;
    await chain(`changes:${sessionId}`, async () => {
      const records = (await readChangesFile(sessionId))?.records;
      if (!records) return;
      const marked = [];
      const next = records.map((record) => {
        const files = Array.isArray(record?.files) ? record.files : [];
        if (matchKey(record?.root) !== target || files.every(changeFileUnavailable)) return record;
        marked.push(record.checkpointId);
        return {
          ...record,
          files: files.map(unavailableChangeFile),
          revision: (Number(record.revision) || 0) + 1,
          updatedAt: Date.now(),
        };
      });
      if (marked.length === 0) return;
      try {
        await writeChangeRecords(sessionId, next);
        removed.push(...marked.map((checkpointId) => `${path}#${checkpointId}`));
      } catch {
        kept.push(path);
      }
    });
  }
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
  // Replay patches and display patches share one budget, measured in UTF-8 bytes.
  const weight = (file) =>
    ['patch', 'viewPatch'].reduce(
      (sum, key) => sum + (typeof file[key] === 'string' ? Buffer.byteLength(file[key], 'utf8') : 0),
      0
    );
  const largest = [...(kept?.files || []), ...(kept?.outside || [])]
    .filter((file) => weight(file) > 0)
    .sort((left, right) => weight(right) - weight(left));
  for (const file of largest) {
    if (total <= MAX_CHANGE_BYTES_PER_SESSION) break;
    total -= weight(file);
    file.patch = null;
    delete file.patchEncoding;
    delete file.viewPatch;
    file.revertable = false;
    file.reason = 'change is too large to keep for undo';
    file.patchOmitted = true;
  }
}

// Test seam: runs before every change-record write; a throw fails the write.
let changeWriteHookForTest = null;

async function writeChangeRecords(sessionId, records) {
  await changeWriteHookForTest?.(sessionId, records);
  changeRecordsCache.delete(sessionId);
  await mkdir(changesRoot(), { recursive: true });
  if (!changesSweepDone) {
    changesSweepDone = true;
    void sweepDirectory(changesRoot(), CHANGE_RECORD_TTL_MS, MAX_CHANGE_RECORD_FILES);
  }
  await writeJsonAtomically(changesPath(sessionId), { version: CHANGES_VERSION, sessionId, records });
}

const changeContent = (record) =>
  JSON.stringify([
    record.kind,
    record.root,
    record.counts || '',
    record.agents || [],
    record.files || [],
    record.outside || [],
  ]);

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
      // `own`: each file's patch is the session's own tool writes (first
      // before → last after, raw bytes) and its counts their summed deltas;
      // an older record without it holds the net worktree diff and counts.
      ...(clean(next.counts) ? { counts: clean(next.counts) } : {}),
      files,
      // View-only edits outside the root of a Git turn: never undone or
      // replayed, listed only by the session review.
      ...(Array.isArray(next.outside) && next.outside.length ? { outside: next.outside } : {}),
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
    // Any new turn record (Git or not) starts the history again.
    await endClearedHistory(id);
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

// Parsed change records by session, valid while the file's mtime and size are
// unchanged: the session review refreshes every few seconds and must not
// re-read and re-parse a multi-megabyte file each time. Callers never mutate.
const changeRecordsCache = new Map();
const CHANGE_RECORDS_CACHE_SESSIONS = 8;

/** Every retained turn's change record of a session, oldest first. */
export async function loadTurnChangeRecords(sessionId) {
  const id = clean(sessionId);
  if (!id) return [];
  let signature = '';
  try {
    const info = await stat(changesPath(id));
    signature = `${info.mtimeMs}:${info.size}`;
  } catch {
    changeRecordsCache.delete(id);
    return [];
  }
  const cached = changeRecordsCache.get(id);
  if (cached?.signature === signature) return cached.records;
  const records = ((await readChangesFile(id))?.records || [])
    .filter(Boolean)
    .sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0));
  changeRecordsCache.delete(id);
  changeRecordsCache.set(id, { signature, records });
  if (changeRecordsCache.size > CHANGE_RECORDS_CACHE_SESSIONS) {
    changeRecordsCache.delete(changeRecordsCache.keys().next().value);
  }
  return records;
}

export function _setTurnChangeRecordWriteHookForTest(hook) {
  changeWriteHookForTest = typeof hook === 'function' ? hook : null;
}

export function _setTurnSnapshotStoreRootForTest(directory) {
  recordRootOverride = clean(directory);
  writeChains.clear();
  changeRecordsCache.clear();
  sweepDone = false;
  changesSweepDone = false;
}

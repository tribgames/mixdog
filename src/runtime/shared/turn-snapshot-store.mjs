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
import { mkdir, open, readFile, readdir, rm, stat, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomicAsync } from './atomic-file.mjs';
import { withFileLock } from './file-lock.mjs';
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
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(sessionId, settled);
  // A settled chain with nothing queued behind it holds no order to keep.
  void settled.then(() => {
    if (writeChains.get(sessionId) === settled) writeChains.delete(sessionId);
  });
  return next;
}

/** Sessions with a write chain still held (tests). */
export function _turnSnapshotWriteChainCountForTest() {
  return writeChains.size;
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
      if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
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
  return await changesExclusive(id, async () => {
    const count = (await loadChangeState(id))?.records.size || 0;
    await rm(changesPath(id), { force: true });
    await rm(legacyChangesPath(id), { force: true });
    changeRecordsCache.delete(id);
    return count;
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
    if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
    const path = join(changesRoot(), name);
    const sessionId = await changesFileSessionId(path);
    if (!sessionId || ![changesPath(sessionId), legacyChangesPath(sessionId)].includes(path)) continue;
    await changesExclusive(sessionId, async () => {
      // Each file is judged by what it holds, not by the one a read prefers.
      const state = await parseChangesFile(sessionId, path, path === changesPath(sessionId)).catch(() => null);
      if (!state) return;
      const records = [...state.records.values()];
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
        await writeChangeRecords(sessionId, next, path);
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

const changesHash = (sessionId) => createHash('sha256').update(sessionId).digest('hex').slice(0, 24);

// The appendable format lives in its own `.jsonl` file. The previous version
// parsed `<hash>.json` as one JSON document, so it must never find appended
// lines there: after a downgrade it sees no history (and writes its own file
// beside ours) instead of misreading and overwriting what it cannot parse.
function changesPath(sessionId) {
  return join(changesRoot(), `${changesHash(sessionId)}.jsonl`);
}

/** The previous format's file, read as-is until the first write migrates it. */
function legacyChangesPath(sessionId) {
  return join(changesRoot(), `${changesHash(sessionId)}.json`);
}

// A changes file is one JSON line of records (what a full write produces, and
// what older versions wrote) optionally followed by delta lines, each starting
// on a new line: a record that replaces its checkpoint's earlier one, or
// `{"checkpointId":…,"evicted":true}`. An upsert appends its one record
// instead of rewriting the session's history; the file is rewritten whole only
// once the superseded bytes outgrow the live ones. A line that does not parse
// (a torn tail, or damage in the middle) is skipped, deliberately: it costs
// only that one upsert, where failing the read as the old single-document
// format did would hide every other turn too.
const COMPACT_DEAD_FLOOR_BYTES = 1024 * 1024;

const recordBytes = (record) => Buffer.byteLength(JSON.stringify(record), 'utf8');

const changesBasePrefix = (sessionId) => `{"version":${CHANGES_VERSION},"sessionId":${JSON.stringify(sessionId)},"records":[`;

/** The session's parsed changes state: its records by checkpoint (file order),
 *  `live` (their summed JSON bytes) and `dead` (superseded bytes still in the
 *  file). Null when it is not a changes file of this session. An unreadable or
 *  unparsable file throws. */
async function parseChangesFile(sessionId, path, stored) {
  const text = await readFile(path, 'utf8');
  const cut = text.indexOf('\n');
  const baseText = cut < 0 ? text : text.slice(0, cut);
  const base = JSON.parse(baseText);
  if (base?.version !== CHANGES_VERSION || base.sessionId !== sessionId || !Array.isArray(base.records)) return null;
  const records = new Map();
  for (const record of base.records) if (record) records.set(record.checkpointId, deepFreeze(record));
  const prefix = changesBasePrefix(sessionId);
  let live;
  if (base.records.every(Boolean) && baseText.startsWith(prefix) && baseText.endsWith(']}')) {
    // Exactly what JSON.stringify wrote: the records' bytes without re-measuring each.
    const count = base.records.length;
    live = count ? Buffer.byteLength(baseText, 'utf8') - Buffer.byteLength(prefix, 'utf8') - 2 - (count - 1) : 0;
  } else {
    live = [...records.values()].reduce((sum, record) => sum + recordBytes(record), 0);
  }
  let dead = 0;
  if (cut >= 0) {
    for (const line of text.slice(cut + 1).split('\n')) {
      if (!line) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      // One line is one upsert: the turn's record and the turns it evicts.
      if (!item || typeof item.put?.checkpointId !== 'string' || !Array.isArray(item.evict)) continue;
      const gone = (checkpointId) => {
        if (!records.has(checkpointId)) return;
        const size = recordBytes(records.get(checkpointId));
        live -= size;
        dead += size;
      };
      for (const checkpointId of item.evict) {
        gone(checkpointId);
        records.delete(checkpointId);
      }
      gone(item.put.checkpointId);
      records.set(item.put.checkpointId, deepFreeze(item.put));
      live += recordBytes(item.put);
    }
  }
  return { records, live, dead, stored };
}

/** Runs `task` with every other writer of the session's changes files — in this
 *  process (write chain) and in any other (file lock) — held off. Whatever the
 *  task reads of the files is what they hold while it writes. */
function changesExclusive(sessionId, task) {
  return chain(`changes:${sessionId}`, async () => {
    await mkdir(changesRoot(), { recursive: true });
    return await withFileLock(join(changesRoot(), `${changesHash(sessionId)}.lock`), task, { timeoutMs: 30_000 });
  });
}

/** The session id of a changes file, read from its first bytes. */
async function changesFileSessionId(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const match = /^\{"version":\d+,"sessionId":("(?:[^"\\]|\\.)*")/.exec(buffer.toString('utf8', 0, bytesRead));
    return match ? clean(JSON.parse(match[1])) : '';
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** What it takes to store `record` (replacing `priorBytes` of its checkpoint's
 *  earlier record) within the session's byte budget: the oldest other turns to
 *  evict until it fits; a turn that alone exceeds the budget drops its largest
 *  patches (those files stop being revertable) instead of the whole record. */
function boundChangeRecord(state, record, priorBytes) {
  const keepCheckpointId = record.checkpointId;
  let total = state.live - priorBytes + recordBytes(record);
  const evict = [];
  for (const [checkpointId, other] of state.records) {
    if (total <= MAX_CHANGE_BYTES_PER_SESSION) break;
    if (checkpointId === keepCheckpointId) continue;
    const size = recordBytes(other);
    total -= size;
    evict.push([checkpointId, size]);
  }
  if (total <= MAX_CHANGE_BYTES_PER_SESSION) return { record, evict };
  // Stored records are frozen and the caller's files are not ours to edit.
  const kept = {
    ...record,
    files: (record.files || []).map((file) => ({ ...file })),
    ...(record.outside ? { outside: record.outside.map((file) => ({ ...file })) } : {}),
  };
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
  return { record: kept, evict };
}

// Test seam: runs before every change-record write; a throw fails the write.
let changeWriteHookForTest = null;

async function writeChangeFile(sessionId, records) {
  await mkdir(changesRoot(), { recursive: true });
  if (!changesSweepDone) {
    changesSweepDone = true;
    void sweepDirectory(changesRoot(), CHANGE_RECORD_TTL_MS, MAX_CHANGE_RECORD_FILES);
  }
  await writeJsonAtomically(changesPath(sessionId), { version: CHANGES_VERSION, sessionId, records });
  // The previous format's file is superseded; leaving it would let a downgrade
  // resurrect an old history and a later upgrade never read it again.
  await rm(legacyChangesPath(sessionId), { force: true });
}

/** Rewrite the whole file with `records`: the appendable file by default, or
 *  the previous format's file in place when `path` names it. */
async function writeChangeRecords(sessionId, records, path = changesPath(sessionId)) {
  await changeWriteHookForTest?.(sessionId, records);
  changeRecordsCache.delete(sessionId);
  try {
    if (path === legacyChangesPath(sessionId)) {
      await writeJsonAtomically(path, { version: CHANGES_VERSION, sessionId, records });
    } else {
      await writeChangeFile(sessionId, records);
    }
  } finally {
    // A read between the drop above and the rename may have cached the old file.
    changeRecordsCache.delete(sessionId);
  }
}

/** Store one turn's `record` — replacing `priorBytes` of its checkpoint's
 *  earlier one — and evict `evict` ([checkpointId, bytes]): appended to the
 *  file, or the file rewritten when it holds no valid state yet or its dead
 *  bytes outgrew the live ones. The cached state follows the file, so the next
 *  read parses nothing. Resolves to the stored (frozen) record. */
async function storeChangeRecord(sessionId, state, record, priorBytes, evict) {
  await changeWriteHookForTest?.(sessionId, [record]);
  const line = JSON.stringify(record);
  const evictedBytes = evict.reduce((sum, [, size]) => sum + size, 0);
  const live = state.live - priorBytes - evictedBytes + Buffer.byteLength(line, 'utf8');
  const dead = state.dead + priorBytes + evictedBytes;
  const stored = deepFreeze(JSON.parse(line));
  const records = new Map(state.records);
  for (const [checkpointId] of evict) records.delete(checkpointId);
  records.set(record.checkpointId, stored);
  changeRecordsCache.delete(sessionId);
  let fresh = null;
  try {
    if (!state.stored || dead > Math.max(live / 2, COMPACT_DEAD_FLOOR_BYTES)) {
      await writeChangeFile(sessionId, [...records.values()]);
      return stored;
    }
    // One line, one write: the record and its evictions become visible together
    // or (a torn last line is skipped on read) not at all. The caller holds the
    // session's cross-process lock, so no other locked writer's bytes can land
    // inside this line; the line is read back, and an upsert that cannot show
    // its whole line in the file fails instead of reporting success.
    const text = `\n${JSON.stringify({ put: record, evict: evict.map(([checkpointId]) => checkpointId) })}`;
    const expected = Buffer.from(text, 'utf8');
    const handle = await open(changesPath(sessionId), 'a+');
    let info;
    try {
      const prior = await handle.stat();
      try {
        await handle.appendFile(expected);
        const held = Buffer.alloc(expected.length);
        const { bytesRead } = await handle.read(held, 0, held.length, prior.size);
        if (bytesRead !== held.length || !held.equals(expected)) {
          throw new Error('turn change record was not written whole');
        }
      } catch (error) {
        // A line this upsert does not report stored is cut away: a later read
        // must not apply it, and a partial one must not sit in the middle of
        // the file. By the path: Windows refuses (EPERM) to truncate through a
        // handle opened to append.
        await truncate(changesPath(sessionId), prior.size).catch((cut) => {
          error.message += ` (the file was not cut back: ${cut?.message || cut})`;
        });
        throw error;
      }
      info = await handle.stat();
      // Cache what we wrote only if the file is exactly the one we read plus our
      // bytes: any other writer in between changes the size (or replaces the
      // file), and then the next read parses the file instead.
      if (!(state.file && prior.ino === state.file.ino && prior.size === state.file.size)) info = null;
    } finally {
      await handle.close().catch(() => {});
    }
    if (info && info.size === state.file.size + expected.length) {
      fresh = {
        signature: `${changesPath(sessionId)}:${info.mtimeMs}:${info.size}`,
        bytes: info.size,
        records: Promise.resolve({ records, live, dead, stored: true, file: { ino: info.ino, size: info.size } }),
      };
      changeRecordsCache.set(sessionId, fresh);
      trimChangeRecordsCache();
    }
  } finally {
    // Whatever was cached before this write no longer describes the file.
    if (changeRecordsCache.get(sessionId) !== fresh) changeRecordsCache.delete(sessionId);
  }
  return stored;
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
  return await changesExclusive(id, async () => {
    const state = (await loadChangeState(id)) || { records: new Map(), live: 0, dead: 0, stored: false };
    const prior = state.records.get(checkpointId) || null;
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
    const bounded = boundChangeRecord(state, record, prior ? recordBytes(prior) : 0);
    const stored = await storeChangeRecord(id, state, bounded.record, prior ? recordBytes(prior) : 0, bounded.evict);
    // Any new turn record (Git or not) starts the history again.
    await endClearedHistory(id);
    return stored;
  });
}

/** Apply `mutate(record)` (returning the next files, or null for no change)
 *  and bump the revision. Serialized with every other write of the session. */
export async function updateTurnChangeRecord(sessionId, checkpointId, mutate) {
  const id = clean(sessionId);
  const key = clean(checkpointId);
  if (!id || !key) return null;
  return await changesExclusive(id, async () => {
    const state = await loadChangeState(id);
    const prior = state?.records.get(key);
    if (!prior) return null;
    const files = mutate(prior);
    if (!files) return prior;
    const record = {
      ...prior,
      files,
      revision: (Number(prior.revision) || 0) + 1,
      updatedAt: Date.now(),
    };
    return await storeChangeRecord(id, state, record, recordBytes(prior), []);
  });
}

/** One turn's change record by its exact checkpoint id; never a fallback. */
export async function loadTurnChangeRecord(sessionId, checkpointId) {
  const id = clean(sessionId);
  const key = clean(checkpointId);
  if (!id || !key) return null;
  return (await loadChangeState(id))?.records.get(key) || null;
}

/** How many turn records the session retains; parses nothing once cached. */
export async function countTurnChangeRecords(sessionId) {
  const id = clean(sessionId);
  return id ? (await loadChangeState(id))?.records.size || 0 : 0;
}

// Parsed change records by session, valid while the file's mtime and size are
// unchanged: the session review and every turn card read the same multi-
// megabyte file and must not re-read and re-parse it each time. An entry holds
// the parse's promise, so concurrent readers of one file share a single parse.
// Least recently used first; bounded by session count and by the summed file
// bytes (the newest entry always stays, however large). Records are shared and
// deep-frozen, and every write drops the entry.
const changeRecordsCache = new Map();
const CHANGE_RECORDS_CACHE_SESSIONS = 8;
const CHANGE_RECORDS_CACHE_BYTES = 64 * 1024 * 1024;

function trimChangeRecordsCache() {
  let bytes = 0;
  for (const entry of changeRecordsCache.values()) bytes += entry.bytes;
  while (
    changeRecordsCache.size > 1 &&
    (changeRecordsCache.size > CHANGE_RECORDS_CACHE_SESSIONS || bytes > CHANGE_RECORDS_CACHE_BYTES)
  ) {
    const [oldest, entry] = changeRecordsCache.entries().next().value;
    changeRecordsCache.delete(oldest);
    bytes -= entry.bytes;
  }
}

/** Every retained turn's change record of a session, oldest first. */
export async function loadTurnChangeRecords(sessionId) {
  const id = clean(sessionId);
  if (!id) return [];
  const state = await loadChangeState(id);
  return state ? [...state.records.values()].sort((left, right) => (Number(left.createdAt) || 0) - (Number(right.createdAt) || 0)) : [];
}

/** The session's cached changes state, or null when it has none readable. */
async function loadChangeState(id) {
  let info;
  let path = changesPath(id);
  let stored = true;
  try {
    info = await stat(path).catch(async () => {
      stored = false;
      path = legacyChangesPath(id);
      return await stat(path);
    });
  } catch {
    changeRecordsCache.delete(id);
    return null;
  }
  const signature = `${path}:${info.mtimeMs}:${info.size}`;
  const cached = changeRecordsCache.get(id);
  changeRecordsCache.delete(id);
  if (cached?.signature === signature) {
    changeRecordsCache.set(id, cached);
    try {
      return await cached.records;
    } catch {
      if (changeRecordsCache.get(id) === cached) changeRecordsCache.delete(id);
      return null;
    }
  }
  const entry = {
    signature,
    bytes: info.size,
    // `file` is what the stat above saw; a parse that read newer bytes only
    // makes the append check in storeChangeRecord refuse to cache.
    records: parseChangesFile(id, path, stored).then((state) => state && { ...state, file: { ino: info.ino, size: info.size } }),
  };
  changeRecordsCache.set(id, entry);
  trimChangeRecordsCache();
  try {
    return await entry.records;
  } catch {
    // A failed read is not remembered: the next call reads the file again.
    if (changeRecordsCache.get(id) === entry) changeRecordsCache.delete(id);
    return null;
  }
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

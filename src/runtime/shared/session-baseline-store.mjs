// Session change baselines: the FIRST observed state of every file a session's
// tools wrote, per review owner. The session-wide review (getSessionReviewDiff)
// compares these with the disk for every file a Git baseline tree does not
// cover — a non-Git root, or a file outside the Git root — so interleaved Lead
// and worker edits, external edits and record eviction never change what the
// session started from.
//
// Layout under the turn-snapshot store root:
//   baselines/<hash(session)>.json         index: one entry per file key
//   baselines/<hash(session)>/<sha256>     captured before-bytes (immutable)
//   review-owners/<hash(child)>.json       worker → Lead review attribution
//
// An index entry is `{ key, path, root, state, status, size, sha256?, blob?, at }`:
// `state` is `present` or `absent` (the file did not exist when first seen),
// `status` is `captured` (bytes kept in `blob`), `omitted-binary` /
// `omitted-oversized` (bytes never kept; `sha256` when they were seen) or
// `evicted` (bytes dropped for the storage bound; `sha256` kept). An entry is
// never replaced by a later observation. Which path holds a renamed file (and
// the path whose baseline it came from) follows from the rename `events` —
// `[at, from, to]` moves and `[at, key]` in-place creates/deletes — replayed
// in issue order onto `renames`, the map folded through `foldedAt`.
// `clearedAt` is the epoch of the last Delete history: a capture issued
// before it (in any process) never lands after it; one issued in its very
// millisecond by another process is kept, but marks the index incomplete. `at` values are issue
// times: wall-clock milliseconds, strictly increasing within a process.
//
// Several processes share one index: every write runs under the index's file
// lock, re-reads the index and replays this process's unwritten captures on
// top of it, so no process drops another's entries (first seen wins) and a
// capture published late still lands where it was observed.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, writeFileAtomicAsync } from './atomic-file.mjs';
import { cleanString as clean } from './clean.mjs';
import { NET_TEXT_MAX_BYTES, changePathKey } from './turn-changes.mjs';
import { sweepDirectory, turnSnapshotStoreRoot } from './turn-snapshot-store.mjs';

const BASELINE_VERSION = 1;
/** Largest before-state kept as bytes: the review reads current files up to
 *  the same bound, so every captured baseline can be compared exactly. */
export const BASELINE_FILE_MAX_BYTES = NET_TEXT_MAX_BYTES;
// Captured bytes per session; past it the oldest captures are evicted.
const MAX_BLOB_BYTES_PER_SESSION = 64 * 1024 * 1024;
// Files (and renamed paths) per session; past it the index is marked incomplete.
const MAX_FILES_PER_SESSION = 4096;
// Rename events kept unfolded; a capture older than the folded ones cannot be
// placed among them and marks the index incomplete.
const MAX_RENAME_EVENTS = MAX_FILES_PER_SESSION;
const MAX_BASELINE_SESSIONS = 512;
const MAX_OWNER_RECORDS = 4096;
const BASELINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Age and count sweeps of the whole store run at most this often per process.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// A blob directory without an index is only pruned once this old: its first
// index write may still be on the way.
const ORPHAN_BLOB_GRACE_MS = 60 * 60 * 1000;
const STATE_CACHE_SESSIONS = 16;
const LOCK_TIMEOUT_MS = 10_000;
// Measured review rows kept between polls, across every session.
const ROW_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const STATUSES = new Set(['captured', 'omitted-binary', 'omitted-oversized', 'evicted']);
const SHA256 = /^[0-9a-f]{64}$/;

const hashName = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const baselinesRoot = () => join(turnSnapshotStoreRoot(), 'baselines');
const ownersRoot = () => join(turnSnapshotStoreRoot(), 'review-owners');
const indexPath = (sessionId) => join(baselinesRoot(), `${hashName(sessionId)}.json`);
const blobDir = (sessionId) => join(baselinesRoot(), hashName(sessionId));
const ownerPath = (sessionId) => join(ownersRoot(), `${hashName(sessionId)}.json`);
// Memory is keyed by store root too: a data-dir retarget never reads stale state.
const memoryKey = (sessionId) => `${turnSnapshotStoreRoot()}\0${sessionId}`;

// Issue times: a capture issued after a clear in this process is always
// later than it, even within one millisecond.
let lastIssue = 0;
function issueTime() {
  const now = Date.now();
  lastIssue = now > lastIssue ? now : lastIssue + 1 / 64;
  return lastIssue;
}

// Call order across sessions: captures, loads and clears pass through one
// queue that only resolves review owners and hands each task to its session's
// chain, so a worker's capture reaches its Lead's chain before a later Lead
// capture, a load follows every capture issued before it and a clear follows
// (and wins over) them. Tasks run on the session chains, not on this queue.
let ordering = Promise.resolve();
function inOrder(task) {
  const run = ordering.then(task);
  ordering = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Per-session serial chain: captures apply in the order `inOrder` hands them
// over, a load reads after every capture queued before it, and a clear lands
// between them.
const chains = new Map();
function chain(key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, settled);
  settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}

// ── Index state ─────────────────────────────────────────────────────────────

const states = new Map();

function emptyState(sessionId) {
  return {
    sessionId,
    incomplete: false,
    // Issue time of the latest capture that made it incomplete (0 = unknown or
    // not a capture): a clear compares it with its own issue time, since only
    // a capture issued after the clear can owe it incompleteness.
    incompleteAt: 0,
    createdAt: 0,
    clearedAt: 0,
    files: new Map(),
    // Paths edited after the clear whose first state is lost: key → { key,
    // path, root, at } (their review lists them as missing; `at` is their
    // latest edit, which tells a later clear whether it predates the entry).
    missing: new Map(),
    // Renames folded through `foldedAt`, the events after it (issue order)
    // and the map both give: renamed path → the path it came from.
    baseRenames: new Map(),
    foldedAt: 0,
    events: [],
    renames: new Map(),
    // `mtime:size` of the index this state was read from ('' = none).
    signature: '',
    // Captures not yet written ({ at, changes }) and the blobs they need.
    pending: [],
    writes: new Map(),
    // Path → the `pending` capture holding its latest edit that recorded
    // nothing (see applyCapture).
    heldRedundant: new Map(),
  };
}

const hasBaselines = (state) => state.files.size > 0 || state.incomplete;

/** The index can no longer vouch for everything, because of the capture issued
 *  at `at` (0 when the cause is not a capture). */
function markIncomplete(state, at = 0) {
  state.incomplete = true;
  if (at > state.incompleteAt) state.incompleteAt = at;
}

function parsedEntry(value) {
  const entry = value && typeof value === 'object' ? value : {};
  const key = clean(entry.key);
  const path = clean(entry.path);
  if (!key || !path || !STATUSES.has(entry.status) || !['present', 'absent'].includes(entry.state)) return null;
  return {
    key,
    path,
    root: clean(entry.root),
    state: entry.state,
    status: entry.status,
    size: Number(entry.size) || 0,
    ...(SHA256.test(entry.sha256 || '') ? { sha256: entry.sha256 } : {}),
    ...(entry.status === 'captured' && SHA256.test(entry.blob || '') ? { blob: entry.blob } : {}),
    at: Number(entry.at) || 0,
    ...(Number(entry.touched) > 0 ? { touched: Number(entry.touched) } : {}),
  };
}

async function indexSignature(sessionId) {
  try {
    const info = await stat(indexPath(sessionId));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return '';
  }
}

/** The index on disk now, as a state carrying its signature. */
async function readState(sessionId) {
  const state = emptyState(sessionId);
  // Stat first: a write landing between the two only costs a later re-read.
  state.signature = await indexSignature(sessionId);
  if (!state.signature) return state;
  let text;
  try {
    text = await readFile(indexPath(sessionId), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...state, signature: '' };
    // Unreadable: what it held is unknown, so nothing may be vouched for.
    return { ...state, incomplete: true };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed?.version !== BASELINE_VERSION || parsed.sessionId !== sessionId) return { ...state, incomplete: true };
  state.incomplete = parsed.incomplete === true;
  state.createdAt = Number(parsed.createdAt) || 0;
  state.incompleteAt = Number(parsed.incompleteAt) || 0;
  state.clearedAt = Number(parsed.clearedAt) || 0;
  for (const value of Array.isArray(parsed.files) ? parsed.files : []) {
    const entry = parsedEntry(value);
    if (entry) state.files.set(entry.key, entry);
    else state.incomplete = true;
  }
  for (const value of Array.isArray(parsed.missing) ? parsed.missing : []) {
    const key = clean(value?.key);
    const path = clean(value?.path);
    // `at`: when the path was last edited (absent in older indexes).
    const at = Number(value?.at);
    if (key && path) state.missing.set(key, { key, path, root: clean(value.root), ...(at > 0 ? { at } : {}) });
    else state.incomplete = true;
  }
  for (const pair of Array.isArray(parsed.renames) ? parsed.renames : []) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      state.baseRenames.set(pair[0], pair[1]);
    }
  }
  state.foldedAt = Number(parsed.foldedAt) || 0;
  for (const event of Array.isArray(parsed.events) ? parsed.events : []) {
    if (isRenameEvent(event)) state.events.push(event);
    else state.incomplete = true;
  }
  state.events.sort((left, right) => left[0] - right[0]);
  state.renames = refold(state);
  compactEvents(state);
  return state;
}

/** `fresh` (the index on disk) with this process's unwritten captures of
 *  `prior` replayed on top (a capture issued before a clear is dropped). */
function rebased(fresh, prior) {
  for (const op of prior?.pending || []) holdCapture(fresh, applyCapture(fresh, op, prior.writes));
  return fresh;
}

function remember(sessionId, state) {
  const key = memoryKey(sessionId);
  states.delete(key);
  states.set(key, state);
  // Never forget unwritten captures: only settled states leave the cache.
  for (const [cachedKey, cached] of states) {
    if (states.size <= STATE_CACHE_SESSIONS) break;
    if (cachedKey !== key && cached.pending.length === 0) states.delete(cachedKey);
  }
  return state;
}

/** The session's index state: memory while the index on disk is the one it
 *  was read from, else re-read (another process wrote it). Runs inside its
 *  chain. */
async function stateFor(sessionId) {
  const cached = states.get(memoryKey(sessionId));
  if (cached && cached.signature === (await indexSignature(sessionId))) return remember(sessionId, cached);
  return remember(sessionId, rebased(await readState(sessionId), cached));
}

// ── Capture ─────────────────────────────────────────────────────────────────

const isOmitted = (value) =>
  Boolean(value) && typeof value === 'object' && !(value instanceof Uint8Array) && value.omitted === true;

function contentBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value), 'utf8');
}

/** The first-seen entry of one path, plus the bytes to store for it. */
function baselineEntry({ key, path, root }, before, at) {
  const base = { key, path, root, at };
  if (before == null) return { entry: { ...base, state: 'absent', status: 'captured', size: 0 } };
  if (isOmitted(before)) {
    const status = before.reason === 'binary' ? 'omitted-binary' : 'omitted-oversized';
    return { entry: { ...base, state: 'present', status, size: Number(before.size) || 0 } };
  }
  const bytes = contentBytes(before);
  const sha256 = digest(bytes);
  if (bytes.length > BASELINE_FILE_MAX_BYTES) {
    return { entry: { ...base, state: 'present', status: 'omitted-oversized', size: bytes.length, sha256 } };
  }
  return { entry: { ...base, state: 'present', status: 'captured', size: bytes.length, sha256, blob: sha256 }, bytes };
}

/** Evict the oldest captured bytes until the session fits its budget. The
 *  entry keeps its hash, so an unchanged file still nets away. */
function boundCapturedBytes(state) {
  const captured = [...state.files.values()].filter((entry) => entry.blob).sort((left, right) => left.at - right.at);
  let total = captured.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of captured) {
    if (total <= MAX_BLOB_BYTES_PER_SESSION) break;
    total -= entry.size;
    const { blob: _blob, ...rest } = entry;
    state.files.set(entry.key, { ...rest, status: 'evicted' });
  }
}

/** Keep the session within its file and byte bounds (renames are bounded as
 *  they fold); whatever is dropped marks the index incomplete. Runs on every
 *  write, so entries merged in from another process are bounded too. */
function enforceBounds(state) {
  if (state.files.size > MAX_FILES_PER_SESSION) {
    const newest = [...state.files.values()].sort((left, right) => left.at - right.at).slice(MAX_FILES_PER_SESSION);
    for (const entry of newest) state.files.delete(entry.key);
    markIncomplete(state, Math.max(...newest.map((entry) => entry.touched ?? entry.at)));
  }
  boundCapturedBytes(state);
}

const isRenameEvent = (event) =>
  Array.isArray(event) &&
  (event.length === 2 || event.length === 3) &&
  Number.isFinite(event[0]) &&
  event.slice(1).every((key) => typeof key === 'string' && key.length > 0);

/** Apply one rename event to `map` (renamed path → the path it came from):
 *  a move carries the source's origin to its destination, an in-place
 *  create/delete ends the path's rename. Past the bound, incomplete. */
function foldEvent(map, [at, key, to], state) {
  if (to === undefined) {
    map.delete(key);
    return;
  }
  const origin = map.get(key) ?? key;
  map.delete(key);
  if (origin === to) map.delete(to);
  else if (map.has(to) || map.size < MAX_FILES_PER_SESSION) map.set(to, origin);
  else markIncomplete(state, at);
}

function refold(state) {
  const map = new Map(state.baseRenames);
  for (const event of state.events) foldEvent(map, event, state);
  return map;
}

/** Fold the oldest events into the base map past the event bound. */
function compactEvents(state) {
  const excess = state.events.length - MAX_RENAME_EVENTS;
  if (excess <= 0) return;
  for (const event of state.events.slice(0, excess)) {
    foldEvent(state.baseRenames, event, state);
    state.foldedAt = event[0];
  }
  state.events = state.events.slice(excess);
}

const eventId = (event) => event.join('\0');

/** Place one capture's rename events where it was observed (its issue time),
 *  so a capture another process published late still chains in order, and
 *  update the rename map. Returns whether anything was placed. */
function placeRenameEvents(state, at, events) {
  if (events.length === 0) return false;
  if (at <= state.foldedAt) {
    // Older than history already folded away: its place in it is unknown.
    markIncomplete(state, at);
    for (const event of events) foldEvent(state.baseRenames, event, state);
    state.renames = refold(state);
    return true;
  }
  let index = state.events.length;
  while (index > 0 && state.events[index - 1][0] > at) index -= 1;
  // A capture replayed onto an index that already holds it is not placed twice.
  const placed = new Set();
  for (let other = index - 1; other >= 0 && state.events[other][0] === at; other -= 1) {
    placed.add(eventId(state.events[other]));
  }
  const fresh = placed.size > 0 ? events.filter((event) => !placed.has(eventId(event))) : events;
  if (fresh.length === 0) return false;
  const appended = index === state.events.length;
  state.events = [...state.events.slice(0, index), ...fresh, ...state.events.slice(index)];
  if (appended) for (const event of fresh) foldEvent(state.renames, event, state);
  else state.renames = refold(state);
  compactEvents(state);
  return true;
}

/**
 * Fold one capture batch (`{ at, changes }`) into the state. A change carries
 * its `before` (a new capture) or, replayed, the `entry` it recorded (bytes
 * from `blobs`) or `redundant` (it recorded none). Returns null when nothing
 * changed, else `{ writes, op }`: the blobs to write and the capture reduced
 * to what can still become a baseline — first-seen entries and the rename /
 * existence events, never a before-buffer a baseline already supersedes.
 */
function applyCapture(state, { at, changes }, blobs = null) {
  // Issued before the session's history was last deleted (in any process):
  // it never lands after the clear.
  if (at < state.clearedAt) return null;
  const writes = new Map();
  let dirty = false;
  if (at === state.clearedAt) {
    // A tie with a clear can only come from another process (issue times are
    // strict within one): its order is unknown, so it is kept, unvouched.
    dirty = true;
    markIncomplete(state, at);
  }
  // A later observation of a known path keeps its first state but is noted on
  // the entry (`touched`), so a clear that lands after this capture was issued
  // knows the path was edited after it and its first state is lost.
  // A touch alone is not `dirty`: it is held like a redundant capture, so
  // repeated edits of one path keep only the latest (see below).
  let touched = false;
  const touch = (side) => {
    const existing = state.files.get(side.key);
    if (existing && at > (existing.touched ?? existing.at)) {
      state.files.set(side.key, { ...existing, touched: at });
      touched = true;
    }
    const lost = state.missing.get(side.key);
    if (lost && at > (lost.at ?? 0)) {
      state.missing.set(side.key, { ...lost, at });
      touched = true;
    }
  };
  const add = (side, make) => {
    const existing = state.files.get(side.key);
    // First seen wins: only an earlier observation (another process's,
    // replayed onto this index) replaces an entry.
    if (existing && !(at < existing.at)) {
      touch(side);
      return null;
    }
    if (!existing && state.files.size >= MAX_FILES_PER_SESSION) {
      // A new cause (a later capture than any recorded) is worth a write.
      dirty ||= !state.incomplete || at > state.incompleteAt;
      markIncomplete(state, at);
      return null;
    }
    const made = make();
    const { bytes } = made;
    // The entry it replaces was an observation too.
    const latest = Math.max(existing?.touched ?? 0, existing?.at ?? 0);
    const entry = latest > made.entry.at ? { ...made.entry, touched: latest } : made.entry;
    state.files.set(side.key, entry);
    if (bytes) writes.set(entry.blob, bytes);
    dirty = true;
    return entry;
  };
  const recorded = (change) => {
    if (!change.entry) return baselineEntry(change.source, change.before, at);
    const bytes = change.entry.blob ? blobs?.get(change.entry.blob) : undefined;
    if (!change.entry.blob || bytes) return { entry: change.entry, bytes };
    // Its unwritten bytes went to the byte budget.
    markIncomplete(state, at);
    const { blob: _blob, ...rest } = change.entry;
    return { entry: { ...rest, status: 'evicted' } };
  };
  const events = [];
  const kept = [];
  for (const change of changes) {
    if (change.redundant) touch(change.source);
    const entry = change.redundant ? null : add(change.source, () => recorded(change));
    kept.push({
      source: change.source,
      ...(change.destination ? { destination: change.destination } : {}),
      replaced: change.replaced,
      ...(entry ? { entry } : { redundant: true }),
    });
    if (change.destination) {
      // The destination did not exist before the move; its file descends from
      // whatever the source descended from.
      add(change.destination, () => baselineEntry(change.destination, null, at));
      events.push([at, change.source.key, change.destination.key]);
    } else if (change.replaced) {
      // Created or deleted in place: no longer a renamed file.
      events.push([at, change.source.key]);
    }
  }
  for (const change of changes) {
    // Replayed, it recorded nothing because an earlier capture had — one a
    // clear has since removed: the path's first state is lost, never dropped.
    if (!change.redundant || state.files.has(change.source.key) || state.missing.has(change.source.key)) continue;
    const { key, path, root } = change.source;
    if (state.missing.size < MAX_FILES_PER_SESSION) state.missing.set(key, { key, path, root, at });
    markIncomplete(state, at);
    dirty = true;
  }
  if (placeRenameEvents(state, at, events)) dirty = true;
  if (!dirty) {
    // Recorded nothing new, yet the capture it relies on may still be cleared
    // away before it is written: held (without bytes) until the unwritten
    // captures are. Only each path's latest such edit is kept, since a clear
    // landing between edits must still see the one after it.
    if ((state.pending.length === 0 && !touched) || kept.length === 0) return null;
    const op = { at, changes: kept };
    for (const change of kept) {
      const prior = state.heldRedundant.get(change.source.key);
      if (prior) {
        prior.changes = prior.changes.filter((held) => held.source.key !== change.source.key);
        const index = prior.changes.length === 0 ? state.pending.indexOf(prior) : -1;
        if (index >= 0) state.pending.splice(index, 1);
      }
      state.heldRedundant.set(change.source.key, op);
    }
    return { writes, op };
  }
  if (!state.createdAt) state.createdAt = at;
  return { writes, op: { at, changes: kept } };
}

/** Hold an applied capture until it is written: its reduced form and its
 *  bytes, within the session byte budget (bytes past it are dropped and the
 *  baselines marked incomplete). */
function holdCapture(state, applied) {
  if (!applied) return;
  state.pending.push(applied.op);
  for (const [blob, bytes] of applied.writes) state.writes.set(blob, bytes);
  enforceBounds(state);
  const referenced = new Set([...state.files.values()].map((entry) => entry.blob).filter(Boolean));
  for (const blob of state.writes.keys()) {
    if (referenced.has(blob)) continue;
    state.writes.delete(blob);
    markIncomplete(state, applied.op.at);
  }
}

let lastSweep = { root: '', at: 0 };

async function pruneOrphanBlobDirs() {
  const root = baselinesRoot();
  const names = await readdir(root, { withFileTypes: true }).catch(() => []);
  const indexes = new Set(names.filter((entry) => entry.isFile()).map((entry) => entry.name));
  for (const entry of names) {
    if (!entry.isDirectory() || indexes.has(`${entry.name}.json`)) continue;
    const info = await stat(join(root, entry.name)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > ORPHAN_BLOB_GRACE_MS) {
      await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Age and count bounds of the whole store, at most once per interval. */
async function sweepStore() {
  const root = turnSnapshotStoreRoot();
  if (lastSweep.root === root && Date.now() - lastSweep.at < SWEEP_INTERVAL_MS) return;
  lastSweep = { root, at: Date.now() };
  await sweepDirectory(baselinesRoot(), BASELINE_TTL_MS, MAX_BASELINE_SESSIONS);
  await sweepDirectory(ownersRoot(), BASELINE_TTL_MS, MAX_OWNER_RECORDS);
  await pruneOrphanBlobDirs();
}

const withIndexLock = (sessionId, task) =>
  withFileLock(`${indexPath(sessionId)}.lock`, task, { timeoutMs: LOCK_TIMEOUT_MS });

async function writeIndex(state) {
  await writeFileAtomicAsync(
    indexPath(state.sessionId),
    JSON.stringify({
      version: BASELINE_VERSION,
      sessionId: state.sessionId,
      createdAt: state.createdAt,
      updatedAt: Date.now(),
      ...(state.clearedAt ? { clearedAt: state.clearedAt } : {}),
      ...(state.incomplete ? { incomplete: true } : {}),
      ...(state.incompleteAt ? { incompleteAt: state.incompleteAt } : {}),
      files: [...state.files.values()],
      ...(state.missing.size > 0 ? { missing: [...state.missing.values()] } : {}),
      renames: [...state.baseRenames],
      ...(state.foldedAt ? { foldedAt: state.foldedAt } : {}),
      events: state.events,
    })
  );
  state.signature = await indexSignature(state.sessionId);
}

/** Write the state's unwritten captures: under the index lock, onto the index
 *  as it is on disk now (another process may have written it). Returns the
 *  state now cached. */
async function persistState(sessionId, state) {
  return await withIndexLock(sessionId, async () => {
    let current = state;
    if (current.signature !== (await indexSignature(sessionId))) {
      current = remember(sessionId, rebased(await readState(sessionId), state));
    }
    if (current.pending.length === 0) return current;
    enforceBounds(current);
    const directory = blobDir(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const kept = new Set([...current.files.values()].map((entry) => entry.blob).filter(Boolean));
    // Content-addressed and immutable: an existing blob already holds these
    // bytes. A torn blob fails its hash check on read, so it needs no fsync.
    for (const [blob, bytes] of current.writes) {
      if (kept.has(blob)) await writeFileAtomicAsync(join(directory, blob), bytes, { createOnly: true, fsync: false });
    }
    await writeIndex(current);
    current.pending = [];
    current.writes = new Map();
    current.heldRedundant = new Map();
    // Under the lock no other writer has a blob on the way.
    for (const name of await readdir(directory).catch(() => [])) {
      if (SHA256.test(name) && !kept.has(name)) await rm(join(directory, name), { force: true }).catch(() => {});
    }
    return current;
  });
}

/** Write the state's unwritten captures. A refusal keeps them in memory for
 *  the next capture or load to retry; returns the state now cached. */
async function flush(sessionId, state) {
  if (state.pending.length === 0) return state;
  let current = state;
  try {
    current = await persistState(sessionId, state);
  } catch {
    current = states.get(memoryKey(sessionId)) || state;
  }
  void sweepStore().catch(() => {});
  return current;
}

async function captureInto(sessionId, op) {
  const state = await stateFor(sessionId);
  holdCapture(state, applyCapture(state, op));
  // Captures the disk refused before are retried with this one, even when it
  // records nothing new.
  await flush(sessionId, state);
}

// ── Review owners ───────────────────────────────────────────────────────────

// child session → its Lead ('' = none), durable in review-owners/.
const owners = new Map();
const ownerLookups = new Map();

/** Attribute a worker session's edits to the Lead that launched it. Durable,
 *  and independent of the turn's (trimmed) agent list. */
export function recordReviewOwner(childSessionId, ownerSessionId) {
  const child = clean(childSessionId);
  const owner = clean(ownerSessionId);
  if (!child || !owner || child === owner) return;
  const key = memoryKey(child);
  if (owners.get(key) === owner) return;
  owners.set(key, owner);
  const path = ownerPath(child);
  void chain(`owner:${key}`, async () => {
    await mkdir(ownersRoot(), { recursive: true, mode: 0o700 });
    await writeFileAtomicAsync(
      path,
      JSON.stringify({ version: BASELINE_VERSION, sessionId: child, ownerSessionId: owner, at: Date.now() })
    );
  }).catch(() => {});
}

async function readOwner(sessionId) {
  try {
    const parsed = JSON.parse(await readFile(ownerPath(sessionId), 'utf8'));
    return parsed?.version === BASELINE_VERSION && parsed.sessionId === sessionId ? clean(parsed.ownerSessionId) : '';
  } catch {
    return '';
  }
}

/** Load a session's durable attribution into memory (once per process). */
export function primeReviewOwner(sessionId) {
  const id = clean(sessionId);
  if (!id) return Promise.resolve();
  const key = memoryKey(id);
  if (owners.has(key)) return Promise.resolve();
  let pending = ownerLookups.get(key);
  if (!pending) {
    pending = readOwner(id)
      .then((owner) => {
        if (!owners.has(key)) owners.set(key, owner);
      })
      .finally(() => ownerLookups.delete(key));
    ownerLookups.set(key, pending);
  }
  return pending;
}

/** The session itself, then each Lead it is attributed to (durable
 *  attributions are loaded on the way). */
async function reviewOwnerChain(sessionId, hint) {
  const ids = [sessionId];
  let next = clean(hint);
  if (!next) {
    await primeReviewOwner(sessionId);
    next = owners.get(memoryKey(sessionId)) || '';
  }
  while (next && !ids.includes(next)) {
    ids.push(next);
    await primeReviewOwner(next);
    next = owners.get(memoryKey(next)) || '';
  }
  return ids;
}

/**
 * Record the first-seen state of each changed path in the baselines of the
 * session and of every Lead it is attributed to (`owner`: the Lead a bound
 * worker tracker names). A change is `{ path, root, before, newPath?,
 * replaced? }`: absolute paths, the directory the tool ran in, the bytes
 * before the change (null = absent, or an omitted marker), the rename
 * destination, and whether the file was created or deleted in place.
 */
export function captureSessionBaselines(sessionId, changes, { owner = '' } = {}) {
  const id = clean(sessionId);
  const prepared = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const path = clean(change?.path);
    if (!path) continue;
    const root = clean(change.root);
    const newPath = clean(change.newPath);
    prepared.push({
      source: { key: changePathKey(path), path, root },
      ...(newPath ? { destination: { key: changePathKey(newPath), path: newPath, root } } : {}),
      before: change.before,
      replaced: change.replaced === true,
    });
  }
  if (!id || prepared.length === 0) return;
  // Queued now, in call order: an owner lookup never lets a later capture
  // (or a clear) overtake this one.
  const op = { at: issueTime(), changes: prepared };
  void inOrder(async () => {
    const targets = await reviewOwnerChain(id, owner).catch(() => [id]);
    for (const target of targets) void chain(memoryKey(target), () => captureInto(target, op)).catch(() => {});
  }).catch(() => {});
}

// ── Review ──────────────────────────────────────────────────────────────────

// Measured review rows by session and unit, reused while the disk is
// unchanged; least recently used first out past the shared byte budget.
const rowCache = new Map();
let rowCacheBytes = 0;

function dropRow(key) {
  const hit = rowCache.get(key);
  if (!hit) return;
  rowCache.delete(key);
  rowCacheBytes -= hit.bytes;
}

function dropRows(sessionKey) {
  const prefix = `${sessionKey}\0`;
  for (const key of [...rowCache.keys()]) if (key.startsWith(prefix)) dropRow(key);
}

const rowBytes = (value) =>
  256 +
  Buffer.byteLength(String(value?.sig || '')) +
  Buffer.byteLength(value?.change?.text || '') +
  Buffer.byteLength(String(value?.change?.reason || ''));

/** The row cache view of one session: `get(unit)` / `set(unit, value)`. */
function rowCacheFor(sessionKey) {
  const prefix = `${sessionKey}\0`;
  return {
    get(unit) {
      const key = prefix + unit;
      const hit = rowCache.get(key);
      if (!hit) return undefined;
      rowCache.delete(key);
      rowCache.set(key, hit);
      return hit.value;
    },
    set(unit, value) {
      const key = prefix + unit;
      dropRow(key);
      const bytes = rowBytes(value);
      if (bytes > ROW_CACHE_MAX_BYTES) return;
      rowCache.set(key, { value, bytes });
      rowCacheBytes += bytes;
      while (rowCacheBytes > ROW_CACHE_MAX_BYTES) dropRow(rowCache.keys().next().value);
    },
  };
}

export function _rowCacheBytesForTest() {
  return rowCacheBytes;
}

/** Unwritten capture batches this process holds for the session (tests). */
export function _pendingCapturesForTest(sessionId) {
  return states.get(memoryKey(clean(sessionId)))?.pending.length ?? 0;
}

/** Bytes this process holds for the session's unwritten captures (tests). */
export function _unsavedBytesForTest(sessionId) {
  const state = states.get(memoryKey(clean(sessionId)));
  let bytes = 0;
  for (const value of state?.writes.values() || []) bytes += value.length;
  for (const op of state?.pending || []) {
    for (const change of op.changes) {
      if (change.before != null && !isOmitted(change.before)) bytes += contentBytes(change.before).length;
    }
  }
  return bytes;
}

async function readBlob(sessionId, entry) {
  if (!entry?.blob) return undefined;
  try {
    const path = join(blobDir(sessionId), entry.blob);
    const bytes = await readFile(path);
    if (digest(bytes) === entry.blob) return bytes;
    // A torn blob (unflushed write cut by a crash). Blobs are published whole
    // and never replaced, so a mismatch is damage: drop it, or the create-only
    // write of a later capture of the same content would skip over it.
    await rm(path, { force: true });
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session's baselines after every capture queued so far, or null when it
 * never recorded one: `{ createdAt, incomplete, files, missing, renames,
 * cache, readBlob, unsaved? }`. `files` are immutable entries; `missing`
 * lists `{ key, path, root }` of paths whose first state was lost;
 * `readBlob(entry)`
 * resolves to the captured bytes or undefined. Captures the disk refused are
 * retried first; still refused, `unsaved` reports them (only this process
 * holds them).
 */
export async function loadSessionBaselines(sessionId) {
  const id = clean(sessionId);
  if (!id) return null;
  const key = memoryKey(id);
  const queued = await inOrder(() => ({
    result: chain(key, async () => {
      const state = await flush(id, await stateFor(id));
      if (!hasBaselines(state)) return null;
      // Bytes of captures the disk refused are still measured from memory.
      const unwritten = new Map(state.writes);
      return {
        createdAt: state.createdAt,
        incomplete: state.incomplete,
        files: [...state.files.values()],
        missing: [...state.missing.values()].filter((entry) => !state.files.has(entry.key)),
        renames: new Map(state.renames),
        cache: rowCacheFor(key),
        readBlob: async (entry) => unwritten.get(entry?.blob) ?? (await readBlob(id, entry)),
        ...(state.pending.length > 0 ? { unsaved: true } : {}),
      };
    }),
  }));
  return await queued.result;
}

/** Carry what the index on disk holds from `state.clearedAt` on into the
 *  freshly cleared `state`: another process may have published a capture issued
 *  after this clear while it was waiting for the lock. */
function keepSinceClear(state, onDisk) {
  const { clearedAt } = state;
  // The latest capture issued from the clear on that the index cannot vouch
  // for (0 = none). Capture issue times only: the index's write time is a
  // different clock reading than the clear's issue time.
  let cause = 0;
  for (const entry of onDisk.files.values()) {
    const latest = entry.touched ?? entry.at;
    if (latest < clearedAt) continue;
    if (entry.at < clearedAt) {
      // First seen before the clear, edited again after it: the state it had
      // when the clear landed is lost, so it is listed as missing.
      const { key, path, root } = entry;
      state.missing.set(key, { key, path, root, at: latest });
      cause = Math.max(cause, latest);
      continue;
    }
    state.files.set(entry.key, entry);
    // Issued in the clear's very millisecond: order unknown (see applyCapture).
    if (entry.at === clearedAt) cause = Math.max(cause, clearedAt);
  }
  // A path already listed as missing stays so only when edited from this
  // clear on; one without an edit time (an older index) predates it.
  for (const lost of onDisk.missing.values()) {
    if (lost.at === undefined || lost.at < clearedAt) continue;
    state.missing.set(lost.key, lost);
    cause = Math.max(cause, lost.at);
  }
  // Incompleteness owed to a capture from the clear on stays (an entry the
  // bound rejected leaves nothing else to show); what cannot be placed on
  // either side of the clear is not vouched for.
  if (onDisk.incomplete && onDisk.incompleteAt >= clearedAt) cause = Math.max(cause, onDisk.incompleteAt);
  if (onDisk.foldedAt >= clearedAt) cause = Math.max(cause, onDisk.foldedAt);
  if (state.files.size === 0 && state.missing.size === 0 && cause === 0) return;
  state.createdAt = onDisk.createdAt;
  state.events = onDisk.events.filter((event) => event[0] >= clearedAt);
  state.renames = refold(state);
  if (cause > 0) markIncomplete(state, cause);
}

/** Delete the session's baselines (Delete history): later edits start fresh.
 *  Every capture issued before it — in this process or, by its `clearedAt`
 *  epoch, in another — is dropped; one issued after it is kept. */
export async function clearSessionBaselines(sessionId) {
  const id = clean(sessionId);
  if (!id) return;
  const key = memoryKey(id);
  // Taken at the call: a capture issued after it is never older than it.
  const clearedAt = issueTime();
  const queued = await inOrder(() => ({
    result: chain(key, async () => {
      const cleared = emptyState(id);
      cleared.clearedAt = clearedAt;
      // Memory first: even when the disk refuses the clear, this process
      // never reviews the old baselines again, and its next write replaces
      // the old index.
      cleared.signature = await indexSignature(id);
      remember(id, cleared);
      dropRows(key);
      await withIndexLock(id, async () => {
        await mkdir(baselinesRoot(), { recursive: true, mode: 0o700 });
        const onDisk = await readState(id);
        // A later clear already landed: nothing here predates it.
        if (onDisk.clearedAt >= clearedAt) {
          remember(id, onDisk);
          return;
        }
        keepSinceClear(cleared, onDisk);
        // A tombstone index, not a deletion: its epoch tells other processes
        // which of their unwritten captures predate the clear.
        await writeIndex(cleared);
        const kept = new Set([...cleared.files.values()].map((entry) => entry.blob).filter(Boolean));
        for (const name of await readdir(blobDir(id)).catch(() => [])) {
          if (!kept.has(name)) await rm(join(blobDir(id), name), { recursive: true, force: true });
        }
      });
    }),
  }));
  await queued.result;
}

/** The session was deleted: its baselines and its attribution go with it. */
export async function forgetSessionBaselines(sessionId) {
  const id = clean(sessionId);
  if (!id) return;
  await clearSessionBaselines(id).catch(() => {});
  owners.delete(memoryKey(id));
  await chain(`owner:${memoryKey(id)}`, () => rm(ownerPath(id), { force: true })).catch(() => {});
}

export function _resetSessionBaselinesForTest() {
  states.clear();
  owners.clear();
  ownerLookups.clear();
  rowCache.clear();
  rowCacheBytes = 0;
  lastSweep = { root: '', at: 0 };
}

/** Wait for every capture, load and clear issued so far (tests). */
export async function _settleSessionBaselinesForTest() {
  await inOrder(() => undefined);
  await Promise.all([...chains.values()]);
}

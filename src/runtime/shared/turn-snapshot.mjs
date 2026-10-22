import { isAbsolute, relative, resolve } from 'node:path';
import {
  _resetTurnWorktreeSnapshotsForTest,
  canonicalPath,
  createTurnWorktreeSnapshot,
  noteTurnWorktreeChange,
  refreshTurnWorktreeSnapshot,
  recordTurnWorktreeFileChange,
  resumeTurnWorktreeFilePatch,
  resumeTurnWorktreeSnapshot,
} from './turn-worktree-snapshot.mjs';
import {
  clearSessionChangeHistory as clearStoredChangeHistory,
  loadSessionSnapshotRecords,
  loadTurnChangeRecord,
  loadTurnChangeRecords,
  loadTurnSnapshotRecord,
  saveTurnSnapshotRecord,
  sessionChangeHistoryCleared,
  updateTurnChangeRecord,
  upsertTurnChangeRecord,
} from './turn-snapshot-store.mjs';
import {
  applyTurnChangeFiles,
  changeDisplayPatch,
  changePathKey,
  findChangeFile,
  isBinaryChangeContent,
  measureLegacyChangeFile,
  namedChangePatch,
  repositoryObjectFormat,
  sessionChangeReview,
  splitPatchSections,
  storedChangeFile,
  trackedChangeFile,
  turnChangesReply,
  unknownStateChangeFile,
} from './turn-changes.mjs';
import {
  _resetSessionBaselinesForTest,
  captureSessionBaselines,
  clearSessionBaselines,
  loadSessionBaselines,
  primeReviewOwner,
  recordReviewOwner,
} from './session-baseline-store.mjs';
import {
  boundReviewPatch,
  createReviewPatchBudget,
  filePatchReply,
  patchOmittedFile,
  REVIEW_FILE_PATCH_SHOW_MAX_BYTES,
  reviewDiffTooLarge,
  reviewSectionTruncated,
} from './review-diff.mjs';
import { PATCH_EDIT_MAX_BYTES } from './bounded-file-read.mjs';
import { runGitOffThread } from './git-runner.mjs';
import { cleanString as clean } from './clean.mjs';
import { createLineDiffBudget, lineDiffHunks, unifiedHunksBody } from './bounded-line-diff.mjs';

// Turn-scoped review registry.
//
// Every file tool write folds its exact before/after bytes into the session's
// tracker as ordered own segments per file: a write that starts from the
// bytes the file's last segment ended with extends that segment, any other
// opens a new one, so whatever changed the file in between (a foreign edit)
// is in no segment. The turn review, its change record and every Undo/
// Reapply/latest-turn revert work from those segments only, reverse-applied
// newest first against the current disk with conflict detection: a foreign
// edit outside the turn's hunks survives an Undo, and one overlapping them
// fails it instead of being overwritten. Each file counts the summed line
// deltas of its own writes.
//
// A Git worktree also gets a shadow-index snapshot at turn start: the durable
// baseline of the session-wide review.
//
// Worker trackers remain separate until the worker completes: then its
// segments, owned paths and counts join the Lead turn that is running at that
// moment, or — when the Lead's turn already ended (sealed or sealing) — the
// next Lead turn that opens or reopens: the turn that receives the worker's
// completion and reports it. A worker's edits so land in exactly one turn
// record, and never in a record that was already frozen.

const DISABLED = /^(0|false|off)$/i.test(String(process.env.MIXDOG_TURN_SNAPSHOT || ''));
const TURN_CACHE_MAX = 32;
const MAX_PATCH_BYTES = 2_000_000;
// Room for one maximum-size edit's before and after content plus small edits.
const MAX_TRACKED_CONTENT_BYTES = 2 * PATCH_EDIT_MAX_BYTES + 32 * 1024 * 1024;
const MAX_AGENT_REVIEWS_PER_TURN = 32;
const MAX_AGENT_REVIEW_BYTES_PER_TURN = 4 * 1024 * 1024;

const _turnsBySession = new Map();
const _diffTrackersBySession = new Map();
let _agentTurnSeq = 0;
// Orders every tracked write across trackers, so a worker's segments merge into
// its Lead's in the order the writes happened.
let _writeSeq = 0;
// `${sessionId}\0${checkpointId}` → seals in flight. A sealing turn's change
// record is `pending` and its session refuses Undo/Reapply until it lands.
const _pendingFreezes = new Map();
// Per-session Undo/Reapply chain.
const _changeMutations = new Map();
// `${sessionId}\0${checkpointId}` → path keys whose worktree state is unknown
// and whose record could not even be marked so (the store refused every write).
const _unknownChangeStates = new Map();
// Owner session → worker key → completed worker review waiting for the
// owner's next turn (its turn had ended when they completed), in completion
// order. Bounded like a turn's agents (trimWorkerReviews).
const _parkedWorkerReviews = new Map();
// Owner session → how many times its change history was deleted: a worker
// bound before a delete never writes into the history after it.
const _historyEpochs = new Map();

/** A parked review owns its worker's bound tracker content (`release`). */
function releaseParkedReview(review) {
  if (review.release) releaseDiffTrackerContent(review.source);
}

function dropParkedWorkerReviews(ownerSessionId) {
  for (const review of _parkedWorkerReviews.get(ownerSessionId)?.values() || []) releaseParkedReview(review);
  _parkedWorkerReviews.delete(ownerSessionId);
}

function trimTurnCache() {
  while (_turnsBySession.size > TURN_CACHE_MAX) {
    const oldest = _turnsBySession.keys().next().value;
    if (oldest === undefined) break;
    _turnsBySession.delete(oldest);
    dropParkedWorkerReviews(oldest);
    for (const [sessionId, tracker] of _diffTrackersBySession) {
      if (sessionId === oldest || tracker.ownerSessionId === oldest) {
        _diffTrackersBySession.delete(sessionId);
        // A bound worker's content is read by nothing else; the Lead's own
        // tracker may still be sealing, so it is only unregistered.
        if (sessionId !== oldest) releaseDiffTrackerContent(tracker);
      }
    }
  }
  // Parked reviews of a Lead with no turn in memory (a worker resumed after a
  // restart) are bounded on their own: oldest owner first.
  while (_parkedWorkerReviews.size > TURN_CACHE_MAX) {
    const oldest = _parkedWorkerReviews.keys().next().value;
    if (oldest === undefined) break;
    dropParkedWorkerReviews(oldest);
  }
}

function mergePatches(values) {
  const merged = (Array.isArray(values) ? values : [values])
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
  return boundReviewPatch(merged, MAX_PATCH_BYTES).patch;
}

function pathKey(value) {
  const text = clean(value);
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function displayPath(value) {
  return (
    clean(value)
      .replace(/\\/g, '/')
      .replace(/^[ab]\//, '') || 'unknown file'
  );
}

/** An owned path is the absolute file when the tool resolved one, otherwise
 *  the display path it reported. */
function ownedPathEntry(path, display) {
  const full = clean(path);
  return full && isAbsolute(full) ? resolve(full) : display;
}

/** Owned paths as forward-slashed paths relative to `root`. Absolute entries
 *  outside the root cannot scope a diff of that root and are dropped; relative
 *  entries (a non-Git tracker's display paths) pass through unchanged. */
function ownedPathsUnder(root, owned) {
  const base = resolve(clean(root) || '.');
  const out = new Set();
  for (const value of owned || []) {
    const target = clean(value);
    if (!target) continue;
    if (!isAbsolute(target)) {
      out.add(target.replace(/\\/g, '/'));
      continue;
    }
    const rel = relative(base, target);
    if (!rel || rel === '.' || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) continue;
    out.add(rel.replace(/\\/g, '/'));
  }
  return out;
}

/** Fold one write's line counts into `stats` (owned entry key → summed
 *  counts). A rename moves the source's counts to its destination; a change
 *  that reports no counts (an Undo/Reapply fold) adds nothing. */
function foldOwnStats(stats, raw, source, destination) {
  const measured = Number.isFinite(raw?.additions) || Number.isFinite(raw?.deletions);
  const prior = stats.get(source.key);
  if (destination) stats.delete(source.key);
  const target = destination || source;
  const existing = destination ? stats.get(destination.key) : null;
  if (!prior && !existing && !measured) return;
  stats.set(target.key, {
    path: target.path,
    display: target.display,
    additions: (prior?.additions || 0) + (existing?.additions || 0) + (Number(raw?.additions) || 0),
    deletions: (prior?.deletions || 0) + (existing?.deletions || 0) + (Number(raw?.deletions) || 0),
  });
}

function mergeOwnStats(target, source) {
  for (const [key, entry] of source) {
    const prior = target.get(key);
    target.set(
      key,
      prior
        ? { ...prior, additions: prior.additions + entry.additions, deletions: prior.deletions + entry.deletions }
        : { ...entry }
    );
  }
}

/** Lookup of the tracker's own-write counts by a reviewed file path: relative
 *  to `root`, or (`display`) the tools' display path a tracked patch shows. */
function ownCountIndex(tracker, root, { display = false } = {}) {
  const keyOf = (path) => pathKey(display ? path : resolve(root, path));
  const index = new Map();
  for (const entry of tracker?.ownStats?.values() || []) index.set(keyOf(display ? entry.display : entry.path), entry);
  return (path) => (path ? index.get(keyOf(path)) : undefined);
}

/** Files counted by the summed per-call deltas of their own writes (a
 *  rename's old path included). A file no own write reported counts for
 *  keeps the counts it has. */
function withOwnCounts(files, find) {
  return files.map((file) => {
    const hits = [find(file.path), file.oldPath ? find(file.oldPath) : undefined].filter(Boolean);
    if (hits.length === 0) return file;
    return {
      ...file,
      additions: hits.reduce((sum, hit) => sum + hit.additions, 0),
      deletions: hits.reduce((sum, hit) => sum + hit.deletions, 0),
    };
  });
}

// A change whose bytes were never captured (binary/oversized) carries
// `{ omitted: true, size }` instead of content: the path still counts as
// changed, but nothing can be diffed or reverted from it.
function isOmittedContent(value) {
  return Boolean(value) && typeof value === 'object' && !(value instanceof Uint8Array) && value.omitted === true;
}

function contentBuffer(value) {
  if (value == null) return null;
  if (isOmittedContent(value)) return { omitted: true, size: Number(value.size) || 0, reason: value.reason || null };
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), 'utf8');
}

/** A before-state for the worktree baseline without copying anything above
 *  the per-file snapshot limit: such content becomes an omitted marker. */
function boundedBaselineContent(value) {
  const size = contentByteLength(value);
  if (size > PATCH_EDIT_MAX_BYTES) return { omitted: true, size, reason: 'oversized' };
  return contentBuffer(value);
}

function contentByteLength(value) {
  if (value == null || isOmittedContent(value)) return 0;
  if (value instanceof Uint8Array) return value.length;
  return Buffer.byteLength(String(value), 'utf8');
}

function sameContent(left, right) {
  if (left === null || right === null) return left === right;
  if (isOmittedContent(left) || isOmittedContent(right)) return false;
  return left.length === right.length && left.equals(right);
}

function createDiffTracker(meta = {}) {
  return {
    ownerSessionId: clean(meta.ownerSessionId) || null,
    ownerGeneration: Number(meta.ownerGeneration) || 0,
    checkpointId: clean(meta.checkpointId),
    worktreeRequest: clean(meta.worktreeRequest),
    // The directory the turn ran in: a non-Git record's patch root.
    worktreeRoot: clean(meta.worktreeRoot),
    worktreeContended: false,
    valid: true,
    sealed: false,
    // Bumped when a completion wake reopens the sealed turn, so a seal that
    // started before the reopen cannot mark the reopened turn sealed.
    sealEpoch: 0,
    // The seal (refresh, record, freeze) in flight, if any.
    freezing: null,
    revision: 0,
    // Current path key → { segments }: the file's own segments in write
    // order, each `{ before, after, firstSeq, lastSeq }` whose sides are
    // `{ path, displayPath, content }` (content null = absent).
    chains: new Map(),
    // Current path key → { chain, owned, stats } of a chain an Undo restored,
    // kept so a Reapply puts it back.
    undoneChains: new Map(),
    // The review rendered for one revision (trackerView).
    view: null,
    worktreeSnapshot: null,
    // Session-owned relative paths. These outlive the before/after buffers on
    // purpose: they are what scopes a revert once the exact content is gone.
    ownedPaths: new Set(),
    // Owned entry key → { path, display, additions, deletions }: the summed
    // line deltas of every own write of the file. Outlives the buffers too.
    ownStats: new Map(),
  };
}

function releaseDiffTrackerContent(tracker) {
  if (!tracker) return;
  tracker.chains.clear();
  tracker.undoneChains.clear();
  tracker.view = null;
}

function resetDiffTracker(sessionId, meta = {}) {
  const id = clean(sessionId);
  if (!id) return null;
  const tracker = createDiffTracker(meta);
  _diffTrackersBySession.set(id, tracker);
  return tracker;
}

function trackedContentBytes(tracker) {
  let total = 0;
  for (const chain of tracker.chains.values()) {
    for (const { before, after } of chain.segments) {
      total += contentByteLength(before.content) + contentByteLength(after.content);
    }
  }
  return total;
}

/** A segment that leaves its file where and as it found it. */
function noopSegment({ before, after }) {
  return pathKey(before.path) === pathKey(after.path) && sameContent(before.content, after.content);
}

/** Join one own segment to the chain of the file it starts at. It extends the
 *  chain's last segment when it starts from that segment's exact after bytes;
 *  otherwise something else changed the file in between, and it opens a new
 *  segment so that change stays out of both. A move onto a path another chain
 *  holds lands as a delete of its source and a write of its destination. */
function appendSegment(tracker, segment) {
  const startKey = pathKey(segment.before.path);
  const endKey = pathKey(segment.after.path);
  if (startKey !== endKey && tracker.chains.has(endKey)) {
    appendSegment(tracker, { ...segment, after: { ...segment.before, content: null } });
    appendSegment(tracker, { ...segment, before: { ...segment.after, content: null } });
    return;
  }
  const chain = tracker.chains.get(startKey) || { segments: [] };
  tracker.chains.delete(startKey);
  const last = chain.segments.at(-1);
  if (last && sameContent(last.after.content, segment.before.content)) {
    last.after = segment.after;
    last.lastSeq = segment.lastSeq;
  } else {
    chain.segments.push({ ...segment });
  }
  tracker.chains.set(endKey, chain);
}

const isBinarySide = (content) => isOmittedContent(content) || isBinaryChangeContent(content);

/** What a chain records, relative to `root`: its segments that change
 *  something — of a binary file only the last, since bytes from before a
 *  foreign rewrite cannot be restored around it — as steps with the
 *  root-relative paths of their sides ('' outside the root). `start`/`end`
 *  are the sides the change begins and ends at (a created file has no old
 *  side, a deleted one no new side). Null when the chain changes nothing. */
function chainEdit(chain, root) {
  let segments = chain.segments.filter((segment) => !noopSegment(segment));
  if (segments.length === 0) return null;
  const binary = segments.some(({ before, after }) => [before.content, after.content].some(isBinarySide));
  if (binary) segments = segments.slice(-1);
  const steps = segments.map(({ before, after }) => ({
    before,
    after,
    oldPath: trackedRelativePath(root, before),
    newPath: trackedRelativePath(root, after),
  }));
  const first = steps[0];
  const last = steps.at(-1);
  const start = first.before.content === null ? first.after : first.before;
  const end = last.after.content === null ? last.before : last.after;
  let status = 'M';
  if (first.before.content === null && last.after.content !== null) status = 'A';
  else if (last.after.content === null && first.before.content !== null) status = 'D';
  else if (pathKey(start.path) !== pathKey(end.path)) status = 'R';
  return {
    steps,
    start,
    end,
    status,
    binary,
    inside: steps.every((step) => step.oldPath && step.newPath),
    omitted: steps.some(({ before, after }) => [before.content, after.content].some(isOmittedContent)),
  };
}

/** A side's name in the review: relative to `root` inside it, else the
 *  tool's display path. */
const viewPath = (root, entry) => trackedRelativePath(root, entry) || displayPath(entry.displayPath || entry.path);

/** One step's display section, named as the review shows it, with its line
 *  counts: hunks, a `Binary files … differ` line, or the not-captured note. */
function renderStep({ before, after }, root, budget) {
  const oldGit = `a/${viewPath(root, before)}`;
  const newGit = `b/${viewPath(root, after)}`;
  const oldHeader = before.content === null ? '/dev/null' : oldGit;
  const newHeader = after.content === null ? '/dev/null' : newGit;
  let head = `diff --git ${oldGit} ${newGit}\n`;
  if (before.content === null) head += 'new file mode 100644\n';
  else if (after.content === null) head += 'deleted file mode 100644\n';
  const binaryLine = `Binary files ${oldHeader} and ${newHeader} differ\n`;
  const omitted = [before.content, after.content].find(isOmittedContent);
  if (omitted) {
    let change = 'changed';
    if (after.content === null) change = 'deleted';
    else if (before.content === null) change = 'added';
    const note = `binary/large file ${change} (${omitted.size} bytes; content not captured)\n`;
    return { text: `${head}${note}${binaryLine}`, additions: 0, deletions: 0 };
  }
  if ([before.content, after.content].some(isBinaryChangeContent)) {
    return { text: `${head}${binaryLine}`, additions: 0, deletions: 0 };
  }
  const text = (content) => (content === null ? '' : content.toString('utf8'));
  const { hunks } = lineDiffHunks(text(before.content), text(after.content), budget, [before.content, after.content]);
  let additions = 0;
  let deletions = 0;
  for (const line of hunks.flatMap((hunk) => hunk.lines)) {
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { text: `${head}${unifiedHunksBody(oldHeader, newHeader, hunks)}`, additions, deletions };
}

/** The tracker's own changes as the review shows them: a row per file with
 *  its own counts, and the display patch of its segments, named relative to
 *  the tracker's patch root (a worker without one: the tools' display
 *  paths). Beside a Git root a file outside it is left out, as from the
 *  record's undoable files. Cached per revision; `budget` bounds a render. */
function trackerView(tracker, budget = createLineDiffBudget()) {
  const { root, kind } = trackerPatchRoot(tracker);
  if (tracker.view?.revision === tracker.revision && tracker.view.root === root) return tracker.view;
  const rows = [];
  if (!tracker.valid) {
    // The content is gone: which files changed is known, their diff is not.
    for (const path of ownedPathsUnder(root, tracker.ownedPaths)) {
      rows.push({ path, status: 'M', additions: 0, deletions: 0, text: '' });
    }
  }
  for (const chain of tracker.chains.values()) {
    const edit = chainEdit(chain, root);
    if (!edit || (kind === 'git' && !edit.inside)) continue;
    const rendered = edit.steps.map((step) => renderStep(step, root, budget));
    const path = viewPath(root, edit.end);
    const oldPath = viewPath(root, edit.start);
    const omitted = edit.steps.flatMap(({ before, after }) => [before.content, after.content]).find(isOmittedContent);
    rows.push({
      path,
      ...(oldPath !== path ? { oldPath } : {}),
      status: edit.status,
      additions: rendered.reduce((sum, step) => sum + step.additions, 0),
      deletions: rendered.reduce((sum, step) => sum + step.deletions, 0),
      ...(edit.binary ? { binary: true } : {}),
      // Its bytes were never captured: listed, never diffed or undone.
      ...(omitted ? { omitted: true, size: omitted.size } : {}),
      text: rendered.map((step) => step.text).join(''),
    });
  }
  rows.sort((left, right) => left.path.localeCompare(right.path));
  const bounded = boundReviewPatch(rows.map((row) => row.text).join(''), MAX_PATCH_BYTES);
  const counted = root ? ownCountIndex(tracker, root) : ownCountIndex(tracker, '', { display: true });
  tracker.view = {
    revision: tracker.revision,
    root,
    files: withOwnCounts(
      rows.map(({ text, ...row }) => row),
      counted
    ),
    patch: bounded.patch,
    truncated: bounded.truncated,
  };
  return tracker.view;
}

/** True when `value` (absolute, or relative to `root`) names a path the chain
 *  touched. */
function chainMatchesPath(chain, root, value) {
  const target = clean(value);
  if (!target) return false;
  const key = changePathKey(relative(root, isAbsolute(target) ? resolve(target) : resolve(root, target)));
  return chain.segments.some((segment) =>
    [segment.before, segment.after].some((entry) => {
      const path = trackedRelativePath(root, entry);
      return Boolean(path) && changePathKey(path) === key;
    })
  );
}

/** The owned entries (and their counts) of every path a chain touched. */
function chainOwnership(tracker, chain) {
  const owned = [
    ...new Set(
      chain.segments
        .flatMap((segment) => [segment.before, segment.after])
        .map((entry) => ownedPathEntry(entry.path, displayPath(entry.displayPath || entry.path)))
    ),
  ].filter((entry) => tracker.ownedPaths.has(entry));
  const stats = owned
    .map((entry) => [pathKey(entry), tracker.ownStats.get(pathKey(entry))])
    .filter(([, entry]) => entry);
  return { owned, stats };
}

/** An Undo reverse-applied these chains: the turn no longer changes them, so
 *  they leave its review. Each is kept for a Reapply. */
function undoTrackedChains(tracker, chains) {
  for (const [key, chain] of tracker.chains) {
    if (!chains.includes(chain)) continue;
    const ownership = chainOwnership(tracker, chain);
    tracker.undoneChains.set(key, { chain, ...ownership });
    for (const entry of ownership.owned) tracker.ownedPaths.delete(entry);
    for (const [statKey] of ownership.stats) tracker.ownStats.delete(statKey);
    tracker.chains.delete(key);
  }
  tracker.revision += 1;
}

/** A Reapply forward-applied the undone chains matching `files` again. */
function redoTrackedChains(tracker, root, files) {
  for (const [key, undone] of tracker.undoneChains) {
    const matches = files.some((file) =>
      [file.path, file.oldPath].some((path) => chainMatchesPath(undone.chain, root, path))
    );
    if (!matches) continue;
    tracker.undoneChains.delete(key);
    tracker.chains.set(key, undone.chain);
    for (const entry of undone.owned) tracker.ownedPaths.add(entry);
    for (const [statKey, entry] of undone.stats) tracker.ownStats.set(statKey, entry);
  }
  tracker.revision += 1;
}

/** A new write supersedes whatever an Undo set aside for the paths it
 *  touches (`keys`). */
function dropUndoneChains(tracker, keys) {
  for (const [key, undone] of tracker.undoneChains) {
    const touched = undone.chain.segments.some(
      (segment) => keys.has(pathKey(segment.before.path)) || keys.has(pathKey(segment.after.path))
    );
    if (touched) tracker.undoneChains.delete(key);
  }
}

/**
 * Fold exact committed before/after file states into a session's current turn.
 * A change is `{ path, displayPath, before, after }`; a rename additionally
 * carries `{ newPath, newDisplayPath }`. `budget` is the line-diff budget of
 * the tool call the changes come from. Returns the turn's review patch.
 */
export function recordTurnDiffChanges(sessionId, changes = [], budget = createLineDiffBudget()) {
  if (DISABLED) return '';
  const id = clean(sessionId);
  if (!id) return '';
  const tracker = _diffTrackersBySession.get(id) || resetDiffTracker(id);
  const ownerTracker = tracker?.ownerSessionId ? _diffTrackersBySession.get(tracker.ownerSessionId) : tracker;
  const snapshot = ownerTracker?.worktreeSnapshot;
  const raws = Array.isArray(changes) ? changes : [];
  // Git reports the turn's root canonically (macOS /var -> /private/var):
  // each written path is spelled the same way, or it never relates to it.
  const list = snapshot?.root ? raws.map(canonicalChangePaths) : raws;
  // Independent of this tracker's validity: the session review needs every
  // write's first-seen state even once the turn's buffers are gone.
  captureReviewBaselines(id, tracker, ownerTracker, list, snapshot);
  if (!tracker) return '';
  if (tracker.valid && !tracker.sealed) foldTrackedChanges(tracker, list, snapshot);
  return trackerView(tracker, budget).patch;
}

function canonicalChangePaths(raw) {
  const path = clean(raw?.path);
  const newPath = clean(raw?.newPath);
  return {
    ...raw,
    ...(isAbsolute(path) ? { path: canonicalPath(path) } : {}),
    ...(isAbsolute(newPath) ? { newPath: canonicalPath(newPath) } : {}),
  };
}

const insidePath = (root, path) => {
  const rel = relative(root, path);
  return Boolean(rel) && !isAbsolute(rel) && rel.split(/[\\/]+/)[0] !== '..';
};

/** Hand each change's first-seen state to the session baselines of `sessionId`
 *  and the Lead it works for. A path inside the turn's Git root is skipped: the
 *  shadow baseline tree already vouches for it. */
function captureReviewBaselines(sessionId, tracker, ownerTracker, list, snapshot) {
  const gitRoot = clean(snapshot?.root);
  const root = clean(tracker?.worktreeRoot) || clean(ownerTracker?.worktreeRoot);
  const changes = [];
  for (const raw of list) {
    const path = clean(raw?.path);
    if (!path || !isAbsolute(path)) continue;
    const newPath = isAbsolute(clean(raw?.newPath)) ? resolve(clean(raw.newPath)) : '';
    if (gitRoot && insidePath(gitRoot, path) && (!newPath || insidePath(gitRoot, newPath))) continue;
    const before = raw?.before ?? null;
    const after = raw?.after ?? null;
    if (!newPath && before === null && after === null) continue;
    changes.push({
      path: resolve(path),
      root,
      before,
      ...(newPath ? { newPath } : {}),
      replaced: (before === null) !== (after === null),
    });
  }
  captureSessionBaselines(sessionId, changes, { owner: tracker?.ownerSessionId || '' });
}

/** Fold exact before/after states into `tracker` as own segments (see
 *  appendSegment). `snapshot` — the owning Lead turn's Git baseline, when
 *  tools are writing — learns each written path's first-before bytes. */
function foldTrackedChanges(tracker, list, snapshot) {
  // The content ceiling is enforced BEFORE anything is stored: an over-budget
  // batch invalidates the tracker up front instead of retaining its buffers.
  const incomingBytes = list.reduce(
    (total, raw) => total + contentByteLength(raw?.before) + contentByteLength(raw?.after),
    0
  );
  const storeContent = trackedContentBytes(tracker) + incomingBytes <= MAX_TRACKED_CONTENT_BYTES;
  if (!storeContent) {
    tracker.valid = false;
    releaseDiffTrackerContent(tracker);
  }
  for (const raw of list) {
    const sourcePath = clean(raw?.path);
    if (!sourcePath) continue;
    const sourceKey = pathKey(sourcePath);
    const sourceDisplay = displayPath(raw?.displayPath || sourcePath);
    // Nothing is converted or copied before the ceiling decision: a rejected
    // batch only hands the worktree baseline a bounded value.
    const before = storeContent ? contentBuffer(raw?.before) : boundedBaselineContent(raw?.before);
    const destinationPath = clean(raw?.newPath);
    recordTurnWorktreeFileChange(snapshot, sourcePath, before);
    if (destinationPath) recordTurnWorktreeFileChange(snapshot, destinationPath, null);
    // WHICH files this session wrote has to survive releasing their content —
    // on turn completion, and on the tracked-size ceiling. That list is the
    // attribution a shared worktree cannot otherwise reconstruct. It keeps the
    // ABSOLUTE file: the display path is relative to the session cwd, which
    // is not necessarily the repository root the scoped diff runs from.
    const sourceEntry = ownedPathEntry(sourcePath, sourceDisplay);
    tracker.ownedPaths.add(sourceEntry);
    let destination = null;
    if (destinationPath) {
      const display = displayPath(raw?.newDisplayPath || destinationPath);
      const entry = ownedPathEntry(destinationPath, display);
      tracker.ownedPaths.add(entry);
      destination = { key: pathKey(entry), path: entry, display };
    }
    foldOwnStats(
      tracker.ownStats,
      raw,
      { key: pathKey(sourceEntry), path: sourceEntry, display: sourceDisplay },
      destination
    );
    if (!storeContent) continue;
    const after = contentBuffer(raw?.after);
    if (!destinationPath && before === null && after === null) continue;
    dropUndoneChains(tracker, new Set([sourceKey, ...(destination ? [pathKey(destinationPath)] : [])]));
    _writeSeq += 1;
    const seq = _writeSeq;
    appendSegment(tracker, {
      before: { path: sourcePath, displayPath: sourceDisplay, content: before },
      after: destination
        ? { path: destinationPath, displayPath: destination.display, content: after }
        : { path: sourcePath, displayPath: sourceDisplay, content: after },
      firstSeq: seq,
      lastSeq: seq,
    });
  }
  tracker.revision += 1;
  if (trackedContentBytes(tracker) > MAX_TRACKED_CONTENT_BYTES) {
    tracker.valid = false;
    releaseDiffTrackerContent(tracker);
  }
}

/** Join a completed worker's own segments to its Lead's tracker: both sets
 *  replay in write order, so a worker write between two Lead writes of one
 *  file continues their segment instead of reading as a foreign gap. A
 *  worker whose content was dropped drops the Lead's exact content too. */
function mergeTrackedContent(target, source) {
  // The worker's owned paths and counts joined as well: any view is stale.
  target.revision += 1;
  if (!target.valid) return;
  if (!source.valid) {
    target.valid = false;
    releaseDiffTrackerContent(target);
    return;
  }
  const segmentsOf = (tracker) => [...tracker.chains.values()].flatMap((chain) => chain.segments);
  const written = new Set(
    segmentsOf(source).flatMap((segment) => [pathKey(segment.before.path), pathKey(segment.after.path)])
  );
  const segments = [...segmentsOf(target), ...segmentsOf(source)].sort((left, right) => left.firstSeq - right.firstSeq);
  target.chains = new Map();
  for (const segment of segments) appendSegment(target, segment);
  dropUndoneChains(target, written);
  if (trackedContentBytes(target) > MAX_TRACKED_CONTENT_BYTES) {
    target.valid = false;
    releaseDiffTrackerContent(target);
  }
}

/** Bound worker reviews keyed by worker (a turn's agents, an owner's parked
 *  reviews): oldest out first, by count and retained patch bytes. */
function trimWorkerReviews(reviews, evicted = () => {}) {
  const retainedBytes = () =>
    [...reviews.values()].reduce((total, review) => total + Buffer.byteLength(review.patch || '', 'utf8'), 0);
  while (reviews.size > MAX_AGENT_REVIEWS_PER_TURN || retainedBytes() > MAX_AGENT_REVIEW_BYTES_PER_TURN) {
    const oldest = reviews.keys().next().value;
    if (oldest === undefined) break;
    const review = reviews.get(oldest);
    reviews.delete(oldest);
    evicted(review);
  }
}

function publicAgentReviews(sessionId) {
  const turn = _turnsBySession.get(clean(sessionId));
  if (!turn) return [];
  return [...turn.agents.values()].map((review) => ({ ...review }));
}

/** A whole-worktree baseline cannot attribute concurrent mutations to either
 *  of two live turns sharing it. Mark both permanently contended so they fall
 *  back to their exact session-owned mutation trackers. A SEALED turn is
 *  finished: its baseline already described the worktree exactly, so
 *  contention is decided between live turns only. */
function markWorktreeContention(ownerSessionId, tracker) {
  const root = tracker.worktreeSnapshot?.root;
  for (const [otherSessionId, other] of _diffTrackersBySession) {
    if (otherSessionId === ownerSessionId || other.sealed) continue;
    const sameRequest = Boolean(tracker.worktreeRequest) && other.worktreeRequest === tracker.worktreeRequest;
    const sameRoot = Boolean(root) && other.worktreeSnapshot?.root === root;
    if (!sameRequest && !sameRoot) continue;
    tracker.worktreeContended = true;
    other.worktreeContended = true;
  }
}

/** A completion wake belongs to the user turn that launched its workers. It
 *  reopens that turn's review instead of replacing it, so the Lead's earlier
 *  edits and every worker attributed to the turn stay in one review — the same
 *  scope the composer bar draws from the last user prompt. */
function continueTurnSnapshot(ownerSessionId) {
  const turn = _turnsBySession.get(ownerSessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (!turn || !tracker || tracker.ownerGeneration !== turn.generation) return false;
  _turnsBySession.delete(ownerSessionId);
  _turnsBySession.set(ownerSessionId, turn);
  tracker.sealed = false;
  tracker.sealEpoch += 1;
  markWorktreeContention(ownerSessionId, tracker);
  adoptParkedWorkerReviews(ownerSessionId, turn, tracker);
  return true;
}

/** Start a new user turn and invalidate the prior turn's child review group.
 *  `continueTurn` (a completion wake) reopens the current turn instead.
 *  Resolves to the turn's `{ generation, checkpointId }`: completing with it
 *  can only ever seal this turn, never a newer one. */
export async function beginTurnSnapshot(worktree, sessionId, options = {}) {
  const ownerSessionId = clean(sessionId);
  if (DISABLED || !ownerSessionId) return undefined;
  // A worker resumed after a restart still credits its Lead's review (a
  // capture racing this lookup waits for it).
  void primeReviewOwner(ownerSessionId);
  // Turn start and Undo/Reapply share the per-session lock: a start waits for
  // an in-flight mutation, and a mutation queued after this start re-checks
  // under the lock and finds the turn running.
  const { token, tracker } = _changeMutations.has(ownerSessionId)
    ? await serializeChangeMutation(ownerSessionId, async () => openTurnSnapshot(worktree, ownerSessionId, options))
    : openTurnSnapshot(worktree, ownerSessionId, options);
  if (!tracker) return token;
  try {
    const snapshot = await createTurnWorktreeSnapshot(worktree);
    if (_diffTrackersBySession.get(ownerSessionId) === tracker) {
      tracker.worktreeSnapshot = snapshot;
      if (snapshot?.root) markWorktreeContention(ownerSessionId, tracker);
    }
  } catch {
    // Git is optional. Exact apply_patch tracking remains the fallback.
  }
  return token;
}

/** The synchronous half of a turn start: reopen (completion wake) or install
 *  the turn's tracker. `tracker` is set only for a new turn, whose Git
 *  baseline the caller captures next. */
function openTurnSnapshot(worktree, ownerSessionId, options) {
  if (options?.continueTurn === true && continueTurnSnapshot(ownerSessionId)) {
    const reopened = _diffTrackersBySession.get(ownerSessionId);
    return { token: { generation: reopened.ownerGeneration, checkpointId: reopened.checkpointId }, tracker: null };
  }
  const generation = (_turnsBySession.get(ownerSessionId)?.generation || 0) + 1;
  const checkpointId = clean(options?.checkpointId);
  // A turn replaced before it sealed (an abort whose delayed cleanup has not
  // run yet) still keeps its edits as a record. Its capture is queued on the
  // worktree lock ahead of this turn's baseline.
  const prior = _diffTrackersBySession.get(ownerSessionId);
  if (prior && prior.ownerGeneration > 0 && !prior.sealed) void sealTurn(ownerSessionId, prior).catch(() => {});
  // Workers still running keep their bound trackers across the new turn:
  // their edits join whichever turn is running when they complete.
  _turnsBySession.delete(ownerSessionId);
  const turn = {
    generation,
    checkpointId,
    agents: new Map(),
  };
  _turnsBySession.set(ownerSessionId, turn);
  const worktreeRequest = pathKey(worktree);
  const tracker = resetDiffTracker(ownerSessionId, {
    ownerGeneration: generation,
    checkpointId,
    worktreeRequest,
    worktreeRoot: resolve(clean(worktree) || '.'),
  });
  trimTurnCache();
  if (tracker) {
    markWorktreeContention(ownerSessionId, tracker);
    adoptParkedWorkerReviews(ownerSessionId, turn, tracker);
  }
  _turnOpenedHookForTest?.(ownerSessionId, checkpointId);
  return { token: { generation, checkpointId }, tracker };
}

// Test seam: runs synchronously the instant a new turn's tracker is installed,
// i.e. the earliest moment that turn could touch the worktree.
let _turnOpenedHookForTest = null;
export function _setTurnOpenedHookForTest(hook) {
  _turnOpenedHookForTest = typeof hook === 'function' ? hook : null;
}

/** Bind one worker execution to its Lead. A Lead with no turn in memory (a
 *  worker resumed after a restart) binds generation 0: its completion waits
 *  for the Lead's next turn. */
export function beginAgentTurnReview(ownerSessionId, childSessionId, meta = {}) {
  if (DISABLED) return null;
  const owner = clean(ownerSessionId);
  const child = clean(childSessionId);
  // Durable: the worker's edits join the Lead's session review even when it
  // runs its own session turn, and whatever the turn's agent list keeps.
  recordReviewOwner(child, owner);
  if (!owner || !child) return null;
  const generation = _turnsBySession.get(owner)?.generation || 0;
  const existingTracker = _diffTrackersBySession.get(child);
  if (!existingTracker || existingTracker.ownerSessionId !== owner || existingTracker.ownerGeneration !== generation) {
    resetDiffTracker(child, {
      ownerSessionId: owner,
      ownerGeneration: generation,
    });
  }
  _agentTurnSeq += 1;
  return {
    id: `agent-review-${_agentTurnSeq}`,
    ownerSessionId: owner,
    generation,
    historyEpoch: _historyEpochs.get(owner) || 0,
    sessionId: child,
    agent: clean(meta.agent) || null,
    tag: clean(meta.tag) || null,
    completed: false,
  };
}

/** The Lead turn is running: not sealed, not sealing. */
const turnRunning = (turn, tracker) =>
  Boolean(turn && tracker) &&
  tracker.ownerGeneration === turn.generation &&
  !tracker.sealed &&
  !tracker.freezing &&
  !tracker.discarded;

/** Attribute one completed worker review to `turn` and fold its own segments,
 *  owned paths and counts into the turn's tracker. */
function joinWorkerReview(turn, ownerTracker, review) {
  const { key, source, tracked, patch } = review;
  const prior = turn.agents.get(key);
  if (!patch) {
    if (!(tracked && prior)) return false;
    turn.agents.delete(key);
    return true;
  }
  turn.agents.delete(key);
  turn.agents.set(key, {
    sessionId: key,
    agent: review.agent || prior?.agent || null,
    tag: review.tag || prior?.tag || null,
    patch: tracked ? patch : mergePatches([prior?.patch, patch]),
  });
  if (source && ownerTracker !== source) foldWorkerTracker(ownerTracker, source);
  trimWorkerReviews(turn.agents);
  return true;
}

/** Fold a finished worker's owned paths, counts and own segments into
 *  `target`. */
function foldWorkerTracker(target, source) {
  for (const path of source.ownedPaths) target.ownedPaths.add(path);
  mergeOwnStats(target.ownStats, source.ownStats);
  mergeTrackedContent(target, source);
}

/** One parked review of a worker that completed again before its Lead's next
 *  turn: both runs' sources fold into one tracker this review owns — the
 *  older run's own bound tracker, else a fresh one, never a worker session's
 *  own tracker — exactly as both would have joined a running turn. The patch
 *  is the merged tracker's cumulative view when tracked, else the merged
 *  apply_patch diffs. */
function mergeParkedReview(prior, review) {
  const sources = [prior.source, review.source].filter(Boolean);
  let source = null;
  if (sources.length > 0) {
    source = prior.release && prior.source ? prior.source : createDiffTracker();
    for (const other of sources) if (other !== source) foldWorkerTracker(source, other);
  }
  releaseParkedReview(review);
  const tracked = prior.tracked || review.tracked;
  return {
    key: review.key,
    source,
    tracked,
    patch: tracked ? trackerView(source).patch : mergePatches([prior.patch, review.patch]),
    agent: review.agent || prior.agent,
    tag: review.tag || prior.tag,
    release: Boolean(source),
  };
}

/** Park a completed worker review for its Lead's next turn. A newer
 *  completion of the same worker merges into the parked one (every run's
 *  edits are kept, as a running turn keeps them); the parked reviews are
 *  bounded by the turn's own limits, and an evicted one releases its tracker
 *  content. */
function parkWorkerReview(ownerSessionId, review) {
  const parked = _parkedWorkerReviews.get(ownerSessionId) || new Map();
  const prior = parked.get(review.key);
  if (!prior && !review.patch) {
    releaseParkedReview(review);
    return false;
  }
  parked.delete(review.key);
  parked.set(review.key, prior ? mergeParkedReview(prior, review) : review);
  trimWorkerReviews(parked, releaseParkedReview);
  _parkedWorkerReviews.set(ownerSessionId, parked);
  trimTurnCache();
  return true;
}

/** A turn that just opened (or reopened) takes the worker reviews that
 *  completed while its Lead had no running turn. */
function adoptParkedWorkerReviews(ownerSessionId, turn, tracker) {
  const parked = _parkedWorkerReviews.get(ownerSessionId);
  if (!parked) return;
  _parkedWorkerReviews.delete(ownerSessionId);
  for (const review of parked.values()) {
    joinWorkerReview(turn, tracker, review);
    releaseParkedReview(review);
  }
}

/** Hand a finished worker's own edits (its tracker, else its apply_patch
 *  diffs) to its Lead: into the Lead turn running now, or — when none runs —
 *  parked for the Lead's next turn to open or reopen. Everything a seal
 *  reads is published before this returns, so a seal started right after it
 *  already includes the worker. */
export function completeAgentTurnReview(handle, patches = []) {
  if (!handle || handle.completed === true) return false;
  handle.completed = true;
  const ownerSessionId = clean(handle.ownerSessionId);
  const key = clean(handle.sessionId) || handle.id;
  const tracker = _diffTrackersBySession.get(key);
  const matchingTracker =
    tracker && tracker.ownerSessionId === ownerSessionId && tracker.ownerGeneration === handle.generation;
  // This execution is over: its bound tracker leaves the registry, so a next
  // execution of the worker starts its own.
  if (matchingTracker) _diffTrackersBySession.delete(key);
  // The Lead's change history was deleted after this worker was bound.
  if ((_historyEpochs.get(ownerSessionId) || 0) !== (handle.historyEpoch || 0)) {
    if (matchingTracker) releaseDiffTrackerContent(tracker);
    return false;
  }
  // A worker that runs its own session turn replaces the bound tracker with
  // its turn's own one (no owner). beginAgentTurnReview reset any older
  // tracker, so an unowned one here holds this execution's edits.
  const source = matchingTracker || (tracker && !tracker.ownerSessionId) ? tracker : null;
  const tracked = Boolean(source) && source.revision > 0;
  const review = {
    key,
    source,
    tracked,
    patch: tracked ? trackerView(source).patch : mergePatches(patches),
    agent: handle.agent,
    tag: handle.tag,
    release: Boolean(matchingTracker),
  };
  const turn = _turnsBySession.get(ownerSessionId);
  const ownerTracker = _diffTrackersBySession.get(ownerSessionId);
  if (turnRunning(turn, ownerTracker)) {
    const joined = joinWorkerReview(turn, ownerTracker, review);
    releaseParkedReview(review);
    return joined;
  }
  return parkWorkerReview(ownerSessionId, review);
}

/** Persist the durable half of a finished review: the baseline tree hash plus
 *  the paths this session owns. Memory keeps the fast path; the record is what
 *  survives the next turn, a cache eviction and a runtime restart. A CONTENDED
 *  worktree is recorded too — the baseline is still exact, and the owned paths
 *  are precisely the attribution that contention destroys. */
async function persistTurnSnapshotRecord(ownerSessionId, tracker) {
  const snapshot = tracker?.worktreeSnapshot;
  if (!ownerSessionId || tracker.discarded || !snapshot?.baselineTree || !snapshot.root) return;
  const owned = [...ownedPathsUnder(snapshot.root, tracker.ownedPaths)];
  if (owned.length === 0) return;
  try {
    await saveTurnSnapshotRecord(ownerSessionId, {
      generation: tracker.ownerGeneration || _turnsBySession.get(ownerSessionId)?.generation || 0,
      checkpointId: tracker.checkpointId,
      root: snapshot.root,
      baselineTree: snapshot.baselineTree,
      baselineFiles: [...snapshot.baselineFiles.values()],
      toolFiles: owned,
      sealed: true,
    });
  } catch {
    /* the record adds to a review, it is never required by one */
  }
}

/** Workers attributed to the tracker's own turn (identities only: their
 *  patches stay review attribution and never join the net diff). */
function attributedAgents(ownerSessionId, tracker) {
  const turn = _turnsBySession.get(ownerSessionId);
  if (!turn || turn.generation !== tracker.ownerGeneration) return [];
  return [...turn.agents.values()].map((review) => ({
    sessionId: review.sessionId,
    agent: review.agent || null,
    tag: review.tag || null,
  }));
}

/** Path of a tracked entry relative to `root`, or '' outside it (or without
 *  a root). */
function trackedRelativePath(root, entry) {
  const value = clean(entry?.path) || clean(entry?.displayPath);
  if (!root || !value) return '';
  const rel = relative(root, isAbsolute(value) ? resolve(value) : resolve(root, value));
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) return '';
  return rel.replace(/\\/g, '/');
}

/** A record file for an edit the worktree root cannot replay: outside it, or
 *  too large/binary to capture. Display-only (`viewPatch`), never undone. */
function untrackableRecordFile(edit, root, budget) {
  const path = viewPath(root, edit.end);
  const oldPath = viewPath(root, edit.start);
  const named = edit.omitted
    ? []
    : edit.steps.map(({ before, after }) =>
        namedChangePatch({ before: before.content, after: after.content, oldName: path, newName: path, budget })
      );
  const viewPatch = named.map((step) => step.patch).join('');
  return {
    path,
    ...(oldPath !== path ? { oldPath } : {}),
    status: edit.status,
    additions: named.reduce((sum, step) => sum + step.additions, 0),
    deletions: named.reduce((sum, step) => sum + step.deletions, 0),
    ...(viewPatch ? { viewPatch } : {}),
    ...(edit.omitted ? { binary: true } : {}),
    revertable: false,
    reason: edit.omitted ? 'binary/large file content was not captured' : 'file is outside the recorded root',
  };
}

/** The root a tracker's own patches are relative to, and a getter for the
 *  object format `git apply` hashes their binary content with there (one Git
 *  call, made only when asked). */
function trackerPatchRoot(tracker, fallback = '') {
  const git = Boolean(clean(tracker?.worktreeSnapshot?.root));
  const root = git ? tracker.worktreeSnapshot.root : clean(tracker?.worktreeRoot) || clean(fallback);
  let format = null;
  const objectFormat = () => {
    format ||= git ? repositoryObjectFormat(root) : Promise.resolve('sha1');
    return format;
  };
  return { root: root ? resolve(root) : '', kind: git ? 'git' : 'tracked', objectFormat };
}

/** One chain's edit (chainEdit) as a record file: one replayable patch
 *  section per own segment, oldest first, or a view-only entry when it lies
 *  outside the root or its bytes were never captured. `objectFormat` hashes a
 *  binary patch, `budget` bounds the line diff. */
function editChangeFile(edit, root, objectFormat, budget) {
  if (edit.omitted || !edit.inside) return untrackableRecordFile(edit, root, budget);
  const sections = edit.steps.map(({ before, after, oldPath, newPath }) =>
    trackedChangeFile({ oldPath, newPath, before: before.content, after: after.content, objectFormat, budget })
  );
  if (sections.length === 1) return sections[0];
  const path = trackedRelativePath(root, edit.end);
  const oldPath = trackedRelativePath(root, edit.start);
  const base = {
    path,
    ...(oldPath !== path ? { oldPath } : {}),
    status: edit.status,
    additions: sections.reduce((sum, section) => sum + section.additions, 0),
    deletions: sections.reduce((sum, section) => sum + section.deletions, 0),
  };
  const blocked = sections.find((section) => section.revertable !== true);
  if (blocked) return { ...base, revertable: false, reason: blocked.reason };
  return { ...base, revertable: true, patch: Buffer.concat(sections.map((section) => section.patch)) };
}

/** The object format the binary patches of `edits` hash with: resolved (one
 *  Git call) only when one of them replays binary content. */
async function editsObjectFormat(edits, patchRoot) {
  const binary = edits.some((edit) => edit.binary && edit.inside && !edit.omitted);
  return binary ? await patchRoot.objectFormat() : 'sha1';
}

/** Record files of the tracker's own changes. `outside` are those beyond the
 *  root (view-only beside a Git turn's files). */
async function ownRecordFiles(tracker, patchRoot) {
  const { root } = patchRoot;
  if (!tracker.valid) {
    const files = [...ownedPathsUnder(root, tracker.ownedPaths)].map((path) => ({
      path,
      status: 'M',
      additions: 0,
      deletions: 0,
      revertable: false,
      reason: 'file content exceeded the undo tracking limit',
    }));
    return { files, outside: [] };
  }
  const edits = [...tracker.chains.values()].map((chain) => chainEdit(chain, root)).filter(Boolean);
  const objectFormat = await editsObjectFormat(edits, patchRoot);
  // One line-diff budget for the whole seal pass.
  const budget = createLineDiffBudget();
  const files = [];
  const outside = [];
  for (const edit of edits) (edit.inside ? files : outside).push(editChangeFile(edit, root, objectFormat, budget));
  return { files, outside };
}

/** Freeze the turn's own changes into its durable change record: per file,
 *  the session's own segments (its completed workers' included) as one
 *  replayable patch, never the worktree's net diff, counted by the summed
 *  deltas of those writes (`counts: 'own'`; older records without the marker
 *  carry net worktree patches and counts). */
async function freezeTurnChanges(ownerSessionId, tracker, agents) {
  const checkpointId = clean(tracker.checkpointId);
  if (!checkpointId) return null;
  const patchRoot = trackerPatchRoot(tracker);
  if (!patchRoot.root) return null;
  const { files, outside } = await ownRecordFiles(tracker, patchRoot);
  const git = patchRoot.kind === 'git';
  const counted = ownCountIndex(tracker, patchRoot.root);
  const record = await upsertTurnChangeRecord(ownerSessionId, {
    checkpointId,
    kind: patchRoot.kind,
    root: patchRoot.root,
    agents,
    counts: 'own',
    // A non-Git turn has no view-only side list: an edit it cannot replay
    // blocks its Undo like before.
    files: withOwnCounts(git ? files : [...files, ...outside], counted).map(storedChangeFile),
    outside: git ? withOwnCounts(outside, counted).map(storedChangeFile) : [],
  });
  // A fresh freeze measured the disk itself; nothing about it is unknown.
  _unknownChangeStates.delete(pendingFreezeKey(ownerSessionId, checkpointId));
  return record;
}

const pendingFreezeKey = (ownerSessionId, checkpointId) => `${ownerSessionId}\0${clean(checkpointId)}`;

/**
 * Seal a Lead turn: capture the worktree one last time, persist the review
 * baseline and freeze the change record. Single-flight per tracker; a seal
 * requested while another runs waits for it and then seals again only if a
 * completion wake reopened the turn meanwhile.
 */
function sealTurn(ownerSessionId, tracker) {
  // Its history was deleted (clearSessionChangeHistory): never written again.
  if (tracker.discarded) return Promise.resolve();
  if (tracker.freezing) {
    return tracker.freezing.then(() => (tracker.sealed ? undefined : sealTurn(ownerSessionId, tracker)));
  }
  const epoch = tracker.sealEpoch;
  const agents = attributedAgents(ownerSessionId, tracker);
  const key = pendingFreezeKey(ownerSessionId, tracker.checkpointId);
  _pendingFreezes.set(key, (_pendingFreezes.get(key) || 0) + 1);
  const run = (async () => {
    if (tracker.worktreeSnapshot) {
      try {
        await refreshTurnWorktreeSnapshot(tracker.worktreeSnapshot, { force: true });
      } catch {
        // Best-effort refresh: seal with the last captured worktree state.
      }
    }
    if (tracker.discarded || tracker.sealEpoch !== epoch) return;
    tracker.sealed = true;
    await persistTurnSnapshotRecord(ownerSessionId, tracker);
    try {
      if (!tracker.discarded) await freezeTurnChanges(ownerSessionId, tracker, agents);
    } catch {
      /* the change record adds Undo history; it never fails a turn */
    }
    // The bounded own before/after content stays until the next turn: a
    // completion wake reopening it and an Undo/Reapply of this turn fold into it.
  })().finally(() => {
    if (tracker.freezing === run) tracker.freezing = null;
    const count = (_pendingFreezes.get(key) || 1) - 1;
    if (count > 0) _pendingFreezes.set(key, count);
    else _pendingFreezes.delete(key);
  });
  tracker.freezing = run;
  return run;
}

/** Freeze a completed (or cancelled) Lead turn while retaining only its
 *  bounded review data. `expected` — the `{ generation }` beginTurnSnapshot
 *  resolved to — makes a delayed call a no-op once a newer turn began. */
export async function completeTurnSnapshot(sessionId, expected = null) {
  const ownerSessionId = clean(sessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (!tracker) return false;
  const generation = Number(expected?.generation) || 0;
  if (generation && tracker.ownerGeneration !== generation) return false;
  await sealTurn(ownerSessionId, tracker);
  return true;
}

/** Is this turn's review labelled with its uncontended Git baseline? (The
 *  review itself is always the tracker's own segments.) */
function worktreeSnapshotUsable(tracker) {
  return Boolean(tracker && !tracker.worktreeContended && tracker.worktreeSnapshot);
}

/** The latest turn's review once its tracker is gone (the next turn replaced
 *  it, the cache evicted it, the runtime restarted): its change record's
 *  files still applied, with their own counts and recorded patches — never a
 *  worktree diff, so a foreign edit inside an own file stays out. */
async function recordedTurnReview(ownerSessionId, { omitPatch }) {
  const record = await latestTurnRecord(ownerSessionId);
  if (!record) return null;
  const files = (record.files || []).filter((file) => fileState(file) === 'applied');
  const patches = files.map(changeDisplayPatch);
  const rows = files.map((file, index) => {
    const row = {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      additions: Number(file.additions) || 0,
      deletions: Number(file.deletions) || 0,
      ...(file.binary ? { binary: true } : {}),
    };
    // The record dropped its patch for size: still listed too large.
    return recordPatchOmitted(file, patches[index]) ? patchOmittedFile(row) : row;
  });
  const shaped = omitPatch ? { files: rows, patch: '' } : perFileReview(rows, patches.join(''));
  return {
    supported: true,
    files: shaped.files,
    patch: shaped.patch,
    ...(omitPatch ? { patchOmitted: true } : {}),
    ...(shaped.diffTooLarge ? { diffTooLarge: true } : {}),
    snapshotKind: 'scoped',
    revertMode: 'scoped',
    checkpointId: clean(record.checkpointId),
    patchTruncated: false,
    authoritative: true,
    agents: publicAgentReviews(ownerSessionId),
    reason: 'recorded',
  };
}

/** A record file kept without its patch for size. */
const recordPatchOmitted = (file, patch) => file?.patchOmitted === true && !patch;

/** A review reply's files and patch under the per-file caps: a file whose
 *  sections were cut for display, or pass the per-file cap or the total left,
 *  is listed with its counts but without its patch (read on its own when it
 *  is opened). `diffTooLarge` once nothing fit. */
function perFileReview(files, patch) {
  const sections = new Map();
  for (const section of splitPatchSections(Buffer.from(patch || '', 'utf8'))) {
    const key = pathKey(section.newPath ?? section.oldPath ?? '');
    const entry = sections.get(key) || { parts: [], bytes: 0, cut: false };
    entry.parts.push(section.patch);
    entry.bytes += section.patch.length;
    entry.cut ||= reviewSectionTruncated(section.patch);
    sections.set(key, entry);
  }
  const budget = createReviewPatchBudget();
  const omitted = new Set();
  const kept = [];
  for (const [key, entry] of sections) {
    if (!entry.cut && budget.admit(entry.bytes)) kept.push(...entry.parts);
    else omitted.add(key);
  }
  const shaped = files.map((file) => (omitted.has(pathKey(file.path)) ? patchOmittedFile(file) : file));
  const text = Buffer.concat(kept).toString('utf8');
  return { files: shaped, patch: text, diffTooLarge: reviewDiffTooLarge(shaped, text) };
}

/** The latest turn's change record, its unrecordable file states applied. */
async function latestTurnRecord(ownerSessionId) {
  const checkpointId = await latestRecordedCheckpoint(ownerSessionId);
  const stored = checkpointId ? await loadTurnChangeRecord(ownerSessionId, checkpointId).catch(() => null) : null;
  return withUnknownChangeStates(ownerSessionId, stored);
}

/** One file's whole display patch in the tracker's view, rendered on its own
 *  instead of within the reply's caps; '' when the view lists no such file. */
function trackerFilePatch(tracker, path) {
  const { root, kind } = trackerPatchRoot(tracker);
  const key = pathKey(path);
  const budget = createLineDiffBudget();
  for (const chain of tracker.chains.values()) {
    const edit = chainEdit(chain, root);
    if (!edit || (kind === 'git' && !edit.inside) || pathKey(viewPath(root, edit.end)) !== key) continue;
    return edit.steps.map((step) => renderStep(step, root, budget).text).join('');
  }
  return '';
}

/** One file of the latest turn's review with its whole patch, up to the
 *  file-patch read's cap: the file a reply listed `patchOmitted`. */
export async function getTurnReviewFilePatch(_worktree, sessionId, file) {
  const path = clean(file).replace(/\\/g, '/');
  if (DISABLED) return { supported: false, path, patch: '' };
  const ownerSessionId = clean(sessionId);
  if (!ownerSessionId || !path) return { supported: true, path, patch: '' };
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (tracker) return filePatchReply(path, trackerFilePatch(tracker, path));
  // Only a file the recorded review lists, by its own path.
  const record = await latestTurnRecord(ownerSessionId);
  const match = record ? findChangeFile(record, path) : null;
  if (
    !match ||
    fileState(match) !== 'applied' ||
    changePathKey(match.path) !== changePathKey(relativeRecordPath(record, path))
  ) {
    return filePatchReply(path, '');
  }
  const patch = changeDisplayPatch(match);
  if (recordPatchOmitted(match, patch)) return { ...filePatchReply(path, ''), ...patchOmittedFile({}) };
  return filePatchReply(path, patch);
}

/** `value` as findChangeFile reads it: relative to the record's root. */
function relativeRecordPath(record, value) {
  const target = clean(value).replace(/\\/g, '/');
  return isAbsolute(target) && record?.root ? relative(record.root, resolve(target)).replace(/\\/g, '/') : target;
}

function assertCheckpointMatches(expectedCheckpointId, actualCheckpointId) {
  const expected = clean(expectedCheckpointId);
  if (!expected) return;
  const actual = clean(actualCheckpointId);
  if (!actual) throw new Error('turn review checkpoint is unavailable');
  if (actual !== expected) {
    throw new Error('turn review checkpoint changed; refresh the review');
  }
}

/** Return the Lead turn's own-file diff plus attributed child reviews, and
 *  `historyTurns`: the retained turn records clearSessionChangeHistory deletes. */
export async function getTurnReviewDiff(_worktree, sessionId, options = {}) {
  if (DISABLED) return { supported: false, files: [], patch: '', agents: [], historyTurns: 0 };
  const ownerSessionId = clean(sessionId);
  const review = await readTurnReview(ownerSessionId, options);
  const records = await loadTurnChangeRecords(ownerSessionId).catch(() => []);
  return { ...review, historyTurns: records.length };
}

async function readTurnReview(ownerSessionId, options) {
  const turn = _turnsBySession.get(ownerSessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (!tracker) {
    const recorded = await recordedTurnReview(ownerSessionId, { omitPatch: options.summary === true });
    if (recorded) return recorded;
  }
  const view = tracker ? trackerView(tracker) : null;
  const worktree = worktreeSnapshotUsable(tracker);
  let revertMode = '';
  if (worktree) revertMode = 'worktree';
  else if (tracker?.valid && view.files.length) revertMode = 'tracked';
  const shaped = perFileReview(view?.files || [], view?.patch || '');
  return {
    supported: true,
    files: shaped.files,
    patch: shaped.patch,
    ...(shaped.diffTooLarge ? { diffTooLarge: true } : {}),
    snapshotKind: worktree ? 'worktree' : 'tool',
    revertMode,
    checkpointId: clean(turn?.checkpointId || tracker?.checkpointId),
    patchTruncated: false,
    authoritative: Boolean(turn && tracker),
    agents: publicAgentReviews(ownerSessionId),
    ...(turn ? { generation: turn.generation } : { reason: 'no-turn' }),
  };
}

function scopeMatchesWorktree(scope, worktree, tracker) {
  const root = pathKey(scope?.root);
  const trackedRoot = pathKey(tracker?.worktreeSnapshot?.root);
  if (trackedRoot) return root === trackedRoot;
  const requested = pathKey(resolve(clean(worktree) || '.')).replace(/[\\/]+$/, '');
  if (!root || !requested) return false;
  return requested === root || requested.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`);
}

/** Return the session's net change: inside a Git root, the diff from its
 * earliest retained baseline tree to the worktree, scoped to the paths it
 * changed; everywhere else (a non-Git root, files outside the Git root) each
 * file's FIRST state observed in the session — by the Lead or a worker
 * attributed to it — against the disk now. Unlike getTurnReviewDiff this
 * survives user-turn boundaries and has no revert contract; the composer
 * keeps owning latest-turn Undo. */
export async function getSessionReviewDiff(worktree, sessionId) {
  if (DISABLED) return { supported: false, files: [], patch: '' };
  const ownerSessionId = clean(sessionId);
  if (!ownerSessionId) return { supported: true, files: [], patch: '', authoritative: true };
  const [review, baselines, records] = await Promise.all([
    baselineSessionReviewDiff(worktree, ownerSessionId),
    loadSessionBaselines(ownerSessionId).catch(() => null),
    // Read through the mtime-keyed cache: only files no baseline knows (a
    // session recorded before baselines existed) come from them.
    loadTurnChangeRecords(ownerSessionId).catch(() => []),
  ]);
  return await sessionChangeReview(review, { baselines, records });
}

/** What the session review diffs inside a Git root: the stored scope (or
 *  live tracker) of this worktree, the paths the session owns there, and its
 *  earliest baseline tree with the recorded first states that complete it. */
async function sessionReviewScope(worktree, ownerSessionId) {
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  const scopes = await loadSessionSnapshotRecords(ownerSessionId).catch(() => []);
  const stored = scopes.find((scope) => scopeMatchesWorktree(scope, worktree, tracker));
  const root = stored?.root || tracker?.worktreeSnapshot?.root || clean(worktree);
  const ownedPaths = new Set(stored?.toolFiles || []);
  for (const path of ownedPathsUnder(root, tracker?.ownedPaths)) ownedPaths.add(path);
  const baselineTree = stored?.baselineTree || tracker?.worktreeSnapshot?.baselineTree;
  const baselineFiles = new Map((stored?.baselineFiles || []).map((entry) => [pathKey(entry.path), entry]));
  const storedPaths = new Set((stored?.toolFiles || []).map(pathKey));
  for (const entry of tracker?.worktreeSnapshot?.baselineFiles.values() || []) {
    if (!storedPaths.has(pathKey(entry.path))) baselineFiles.set(pathKey(entry.path), entry);
  }
  return { tracker, stored, root, ownedPaths, baselineTree, baselineFiles: [...baselineFiles.values()] };
}

/** `value` (absolute, or relative to `root`) as a path relative to `root`;
 *  null outside it. */
function relativeInside(root, value) {
  const target = clean(value);
  if (!root || !target) return null;
  const rel = relative(resolve(root), isAbsolute(target) ? resolve(target) : resolve(root, target));
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) return null;
  return rel.replace(/\\/g, '/');
}

/** One file of the session review with its whole patch, up to the file-patch
 *  read's cap: the file a reply listed `patchOmitted`. `file` is the listed
 *  file's `id` or path, `oldPath` a rename's source. Inside the Git root it is
 *  the session's baseline tree against the worktree now for that path alone;
 *  elsewhere its first-seen state measured against the disk now. */
export async function getSessionReviewFilePatch(worktree, sessionId, file, oldPath = '') {
  const path = clean(file).replace(/\\/g, '/');
  if (DISABLED) return { supported: false, path, patch: '' };
  const ownerSessionId = clean(sessionId);
  if (!ownerSessionId || !path) return { supported: true, path, patch: '' };
  const scope = await sessionReviewScope(worktree, ownerSessionId);
  const rel = scope.baselineTree ? relativeInside(scope.root, path) : null;
  if (rel !== null) {
    // Each target is authorized on its own: an unowned file is never read,
    // an unowned rename source never joins its diff.
    const owned = new Set([...scope.ownedPaths].map(pathKey));
    if (!owned.has(pathKey(rel))) return { supported: true, path, patch: '' };
    const source = relativeInside(scope.root, oldPath) || '';
    const oldRel = source && owned.has(pathKey(source)) ? source : '';
    const result = await resumeTurnWorktreeFilePatch(scope.root, scope.baselineTree, {
      paths: [...scope.ownedPaths],
      baselineFiles: scope.baselineFiles,
      path: rel,
      oldPath: oldRel,
      maxBytes: REVIEW_FILE_PATCH_SHOW_MAX_BYTES,
    }).catch(() => null);
    if (result) return { supported: true, path, ...result };
  }
  const [base, baselines, records] = await Promise.all([
    // Beside a Git baseline a file outside its root is measured from its
    // first state; the Git side's own files need no diff for that.
    rel === null && scope.baselineTree && scope.root
      ? { supported: true, root: scope.root, files: [], patch: '', source: 'git' }
      : baselineSessionReviewDiff(worktree, ownerSessionId),
    loadSessionBaselines(ownerSessionId).catch(() => null),
    loadTurnChangeRecords(ownerSessionId).catch(() => []),
  ]);
  return await sessionChangeReview(base, { baselines, records, file: path });
}

async function baselineSessionReviewDiff(worktree, ownerSessionId) {
  const { tracker, stored, root, ownedPaths, baselineTree, baselineFiles } = await sessionReviewScope(
    worktree,
    ownerSessionId
  );
  // A running turn is still mutating the worktree: shell, office and script
  // edits only reach the checkpoint diff once it is refreshed, exactly as the
  // turn review bar does.
  if (tracker?.worktreeSnapshot && !tracker.sealed) {
    try {
      await refreshTurnWorktreeSnapshot(tracker.worktreeSnapshot);
    } catch {
      // Best-effort refresh: the checkpoint diff uses the last captured state.
    }
  }
  if (ownedPaths.size === 0) {
    // Authoritatively empty only when the session left ownership metadata
    // behind (a stored scope, a live tracker, or a deleted history); with
    // none, the retained change records are the only memory of what it changed.
    const known = Boolean(stored || tracker) || (await sessionChangeHistoryCleared(ownerSessionId).catch(() => false));
    return {
      supported: true,
      root,
      files: [],
      patch: '',
      snapshotKind: 'session',
      authoritative: true,
      source: known ? 'empty' : 'absent',
    };
  }
  if (root && baselineTree) {
    const snapshot = await resumeTurnWorktreeSnapshot(root, baselineTree, {
      paths: [...ownedPaths],
      baselineFiles,
    }).catch(() => null);
    if (snapshot) {
      return {
        supported: true,
        root,
        files: snapshot.files || [],
        patch: snapshot.patch || '',
        patchTruncated: snapshot.patchTruncated === true,
        snapshotKind: 'session',
        authoritative: true,
        source: 'git',
      };
    }
  }
  // A non-Git first turn still has an exact apply_patch tracker. It cannot
  // cross a runtime restart, but remains preferable to widening into unrelated
  // files from the surrounding directory.
  // `owned` lets the session review flag an owned file no other source knows.
  if (tracker?.valid) {
    return {
      supported: true,
      root,
      files: [],
      patch: '',
      snapshotKind: 'session-tool',
      authoritative: true,
      source: 'tool',
      owned: [...ownedPaths],
    };
  }
  return {
    supported: false,
    root,
    files: [],
    patch: '',
    snapshotKind: 'session',
    authoritative: false,
    reason: 'session baseline is unavailable',
    source: 'unavailable',
    owned: [...ownedPaths],
  };
}

const UNATTRIBUTED_FILE = 'turn review revert cannot attribute this file to the session';

/** Reverse-apply the latest turn's own changes — every file its own tools
 *  wrote (`file` null) or the own file the user picked. A sealed turn undoes
 *  its change record (state included); a running one its tracker's own
 *  segments. Resolves to the turn's checkpoint, the absolute paths touched and
 *  whether the record already carries the new state. */
async function revertLatestTurnUnlocked(worktree, ownerSessionId, file, expectedCheckpointId) {
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (tracker) assertCheckpointMatches(expectedCheckpointId, tracker.checkpointId);
  if (!tracker || tracker.sealed) {
    const checkpointId = clean(tracker?.checkpointId) || (await latestRecordedCheckpoint(ownerSessionId));
    if (!tracker) assertCheckpointMatches(expectedCheckpointId, checkpointId);
    const record = checkpointId ? await loadTurnChangeRecord(ownerSessionId, checkpointId) : null;
    if (record) return await revertRecordedTurn(ownerSessionId, withUnknownChangeStates(ownerSessionId, record), file);
    if (!tracker) throw new Error('turn worktree snapshot is unavailable');
  }
  const paths = await revertTrackedTurn(tracker, worktree, file);
  return { checkpointId: clean(tracker.checkpointId), paths, recorded: false };
}

/** The latest turn on record: the stored Git review's, else the newest change record's. */
async function latestRecordedCheckpoint(ownerSessionId) {
  const snapshot = await loadTurnSnapshotRecord(ownerSessionId).catch(() => null);
  if (clean(snapshot?.checkpointId)) return clean(snapshot.checkpointId);
  const records = await loadTurnChangeRecords(ownerSessionId).catch(() => []);
  return clean(records.at(-1)?.checkpointId);
}

const recordFilePaths = (root, files) =>
  files
    .flatMap((entry) => [entry.path, entry.oldPath])
    .filter(Boolean)
    .map((path) => resolve(root, path));

/** Undo a sealed turn's applied record files (all, or the one named). */
async function revertRecordedTurn(ownerSessionId, record, file) {
  let targets;
  if (file) {
    const match = findChangeFile(record, file);
    if (!match) throw new Error(UNATTRIBUTED_FILE);
    if (fileState(match) !== 'applied') throw new Error(`${match.path} is already undone`);
    targets = [match];
  } else {
    targets = (record.files || []).filter((entry) => fileState(entry) === 'applied');
  }
  if (targets.length > 0) await mutateRecordFiles(ownerSessionId, record, targets, true);
  return { checkpointId: clean(record.checkpointId), paths: recordFilePaths(record.root, targets), recorded: true };
}

/** Undo a running turn's own segments (every file, or the one matching
 *  `file`), newest first. */
async function revertTrackedTurn(tracker, worktree, file) {
  if (!tracker.valid) throw new Error('turn review tracked file snapshot is unavailable');
  const patchRoot = trackerPatchRoot(tracker, resolve(clean(worktree) || '.'));
  const git = patchRoot.kind === 'git';
  let targets = [...tracker.chains.values()]
    .map((chain) => ({ chain, edit: chainEdit(chain, patchRoot.root) }))
    // Beside a Git root, an edit outside it is view-only, never undone.
    .filter(({ edit }) => edit && (!git || edit.inside));
  if (file) {
    const target = targets.find(({ chain }) => chainMatchesPath(chain, patchRoot.root, file));
    if (!target) throw new Error(UNATTRIBUTED_FILE);
    targets = [target];
  }
  if (targets.length === 0) return [];
  for (const { edit } of targets) {
    const omitted = edit.steps.flatMap(({ before, after }) => [before.content, after.content]).find(isOmittedContent);
    if (!omitted) continue;
    throw new Error(
      `turn review revert is unavailable for ${edit.start.displayPath}: binary/large file content was not captured (${omitted.size} bytes)`
    );
  }
  const edits = targets.map(({ edit }) => edit);
  const objectFormat = await editsObjectFormat(edits, patchRoot);
  const budget = createLineDiffBudget();
  const files = edits.map((edit) => storedChangeFile(editChangeFile(edit, patchRoot.root, objectFormat, budget)));
  const blocked = files.find((entry) => entry.revertable !== true);
  if (blocked) throw new Error(`turn review revert is unavailable for ${blocked.path}: ${blocked.reason}`);
  await applyTurnChangeFiles({ root: patchRoot.root, kind: patchRoot.kind, counts: 'own' }, files, {
    reverse: true,
  });
  undoTrackedChains(
    tracker,
    targets.map(({ chain }) => chain)
  );
  const paths = recordFilePaths(patchRoot.root, files);
  noteTurnWorktreeChange(paths);
  if (tracker.worktreeSnapshot) {
    try {
      await refreshTurnWorktreeSnapshot(tracker.worktreeSnapshot, { force: true });
    } catch {
      // Best-effort refresh: the next review read captures afresh.
    }
  }
  return paths;
}

/** Record a running turn's composer Undo in the record an earlier seal of the
 *  same turn left (a completion wake reopened it): a record file whose every
 *  side (a rename's old path too) was undone is `reverted`; every other file
 *  keeps its state. */
async function recordComposerRevert(ownerSessionId, { checkpointId, paths }) {
  if (!ownerSessionId || !checkpointId) return;
  const record = await loadTurnChangeRecord(ownerSessionId, checkpointId);
  if (!record) return;
  const restored = new Set(paths.map((path) => changePathKey(relative(record.root, path))));
  const keys = new Set(
    (record.files || [])
      .filter((entry) => [entry.path, entry.oldPath].filter(Boolean).every((side) => restored.has(changePathKey(side))))
      .map((entry) => changePathKey(entry.path))
  );
  if (keys.size === 0) return;
  try {
    await writeTurnChangeState(ownerSessionId, checkpointId, keys, 'reverted');
  } catch (error) {
    await markTurnChangeStateUnknown(ownerSessionId, checkpointId, keys);
    throw new Error(
      `the turn's files were restored, but its change record could not be updated (${error.message}); Undo/Reapply of those files is disabled`,
      { cause: error }
    );
  }
}

/** Composer Undo of the latest turn, on the per-session change lock shared
 *  with historical Undo/Reapply, recorded in the turn's change record so the
 *  historical view offers Reapply rather than a second Undo. */
function revertLatestTurn(worktree, sessionId, file, expectedCheckpointId) {
  const ownerSessionId = clean(sessionId);
  return serializeChangeMutation(ownerSessionId, async () => {
    // A seal still freezing would record the pre-restore state after this.
    const freezing = _diffTrackersBySession.get(ownerSessionId)?.freezing;
    if (freezing) await freezing.catch(() => {});
    const restored = await revertLatestTurnUnlocked(worktree, ownerSessionId, file, expectedCheckpointId);
    if (!restored.recorded) await recordComposerRevert(ownerSessionId, restored);
    return await getTurnReviewDiff(worktree, ownerSessionId);
  });
}

/** Undo this turn's own changes to one reviewed file (never a restore to HEAD
 *  or to the turn-start bytes: foreign edits outside its hunks stay). */
export function revertTurnReviewFile(worktree, sessionId, file, expectedCheckpointId = '') {
  if (!clean(file)) return Promise.reject(new TypeError('turn review file path is required'));
  return revertLatestTurn(worktree, sessionId, file, expectedCheckpointId);
}

/** Undo this turn's own changes to every file its tools wrote. */
export function revertTurnReview(worktree, sessionId, expectedCheckpointId = '') {
  return revertLatestTurn(worktree, sessionId, null, expectedCheckpointId);
}

// ── Historical turn changes (per-turn Undo/Reapply) ─────────────────────────

/** A Lead turn of this session is running or still sealing. Only a tracker
 *  beginTurnSnapshot opened counts: an orphan tool tracker is no turn. */
function sessionTurnBusy(ownerSessionId) {
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (tracker && tracker.ownerGeneration > 0 && (!tracker.sealed || tracker.freezing)) return true;
  for (const key of _pendingFreezes.keys()) {
    if (key.startsWith(`${ownerSessionId}\0`)) return true;
  }
  return false;
}

function turnChangesPending(ownerSessionId, checkpointId) {
  if (_pendingFreezes.has(pendingFreezeKey(ownerSessionId, checkpointId))) return true;
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  return Boolean(tracker && tracker.ownerGeneration > 0 && !tracker.sealed && tracker.checkpointId === checkpointId);
}

function requiredCheckpointId(value) {
  const checkpointId = clean(value);
  if (!checkpointId) throw new TypeError('checkpointId is required');
  return checkpointId;
}

/** One turn's frozen changes by exact checkpoint id (TurnChangesReply). An
 *  unknown checkpoint is `missing`; it never resolves to the latest turn. */
export async function getTurnChanges(sessionId, options = {}) {
  const ownerSessionId = clean(sessionId);
  const checkpointId = requiredCheckpointId(options?.checkpointId);
  let record = ownerSessionId
    ? withUnknownChangeStates(ownerSessionId, await loadTurnChangeRecord(ownerSessionId, checkpointId))
    : null;
  // An old record's outside-root file kept no counts: measure it so the card
  // agrees with the session review and the island.
  if (record?.files?.length) {
    const budget = createLineDiffBudget();
    record = {
      ...record,
      files: await Promise.all(record.files.map((file) => measureLegacyChangeFile(file, record.root, budget))),
    };
  }
  let status = 'missing';
  if (ownerSessionId && turnChangesPending(ownerSessionId, checkpointId)) status = 'pending';
  else if (record) status = record.files?.length || record.outside?.length ? 'ready' : 'none';
  const reply = turnChangesReply({
    status,
    checkpointId,
    record,
    patch: options?.patch === true,
    file: clean(options?.file) || null,
  });
  return status === 'ready' ? withIgnoredChangeFiles(ownerSessionId, reply) : reply;
}

// The gitignored files of each answered record revision (build output a file
// tool wrote): flagged `ignored` so a viewer can leave them out of its turn
// previews. Asked of Git once per revision; bounded.
const IGNORED_CHANGE_CACHE_LIMIT = 200;
const _ignoredChangeFiles = new Map();

async function ignoredChangePaths(key, root, paths) {
  const cached = _ignoredChangeFiles.get(key);
  if (cached) return cached;
  let ignored = new Set();
  try {
    const result = await runGitOffThread(['check-ignore', '-z', '--stdin'], {
      cwd: root,
      input: `${paths.join('\0')}\0`,
      timeoutMs: 10_000,
      maxBytes: 4 * 1024 * 1024,
    });
    // 0: some are ignored, 1: none; anything else (no repository) flags none.
    if (result.code === 0) ignored = new Set(result.stdout.split('\0').filter(Boolean));
  } catch {
    // No Git to ask: nothing is flagged.
  }
  _ignoredChangeFiles.set(key, ignored);
  while (_ignoredChangeFiles.size > IGNORED_CHANGE_CACHE_LIMIT) {
    _ignoredChangeFiles.delete(_ignoredChangeFiles.keys().next().value);
  }
  return ignored;
}

async function withIgnoredChangeFiles(ownerSessionId, reply) {
  const paths = reply.files.map((file) => file.path).filter((path) => path && !isAbsolute(path));
  if (!reply.root || paths.length === 0) return reply;
  const key = `${ownerSessionId}\0${reply.checkpointId}\0${reply.revision}\0${reply.root}`;
  const ignored = await ignoredChangePaths(key, reply.root, paths);
  if (ignored.size === 0) return reply;
  return { ...reply, files: reply.files.map((file) => (ignored.has(file.path) ? { ...file, ignored: true } : file)) };
}

function serializeChangeMutation(ownerSessionId, task) {
  const previous = _changeMutations.get(ownerSessionId) || Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  _changeMutations.set(ownerSessionId, settled);
  settled.then(() => {
    if (_changeMutations.get(ownerSessionId) === settled) _changeMutations.delete(ownerSessionId);
  });
  return next;
}

const fileState = (file) => (file.state === 'reverted' ? 'reverted' : 'applied');

/** Persist `state` for the record files under `keys`, bumping the revision
 *  when anything changed: the one state write of composer and historical Undo. */
function writeTurnChangeState(ownerSessionId, checkpointId, keys, state) {
  return updateTurnChangeRecord(ownerSessionId, checkpointId, (current) => {
    let changed = false;
    const files = (current.files || []).map((entry) => {
      if (!keys.has(changePathKey(entry.path)) || fileState(entry) === state) return entry;
      changed = true;
      return { ...entry, state };
    });
    return changed ? files : null;
  });
}

const markUnknownStates = (files, keys) =>
  (files || []).map((entry) => (keys.has(changePathKey(entry.path)) ? unknownStateChangeFile(entry) : entry));

/** A state write failed after the worktree changed and could not be undone:
 *  mark those files unknown in the record, or — when the store refuses that
 *  write too — for the rest of this runtime, so no reply reads them as
 *  cleanly applied or reverted. */
async function markTurnChangeStateUnknown(ownerSessionId, checkpointId, keys) {
  try {
    await updateTurnChangeRecord(ownerSessionId, checkpointId, (current) => markUnknownStates(current.files, keys));
    return;
  } catch {
    // The store refused the write: fall back to the in-memory marker below.
  }
  const key = pendingFreezeKey(ownerSessionId, checkpointId);
  _unknownChangeStates.set(key, new Set([...(_unknownChangeStates.get(key) || []), ...keys]));
}

function withUnknownChangeStates(ownerSessionId, record) {
  const keys = record && _unknownChangeStates.get(pendingFreezeKey(ownerSessionId, record.checkpointId));
  return keys ? { ...record, files: markUnknownStates(record.files, keys) } : record;
}

/** Bring the latest-turn review (composer bar, session Diff) in line with an
 *  Undo/Reapply that just landed: signal the moved paths, fold the record's
 *  own chains out of (or back into) the turn's tracker when it is that turn,
 *  re-capture the Git snapshot (sealed ones too) and persist its
 *  attribution. Best-effort: the mutation itself already landed. */
async function refreshLatestTurnReview(ownerSessionId, record, targets, reverse) {
  noteTurnWorktreeChange(recordFilePaths(record.root, targets));
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (!tracker) return;
  if (tracker.valid && clean(tracker.checkpointId) === clean(record.checkpointId)) {
    const root = resolve(record.root);
    if (reverse) {
      const matches = (chain) =>
        targets.some((file) => [file.path, file.oldPath].some((path) => chainMatchesPath(chain, root, path)));
      undoTrackedChains(tracker, [...tracker.chains.values()].filter(matches));
    } else {
      redoTrackedChains(tracker, root, targets);
    }
  }
  if (!tracker.worktreeSnapshot) return;
  try {
    await refreshTurnWorktreeSnapshot(tracker.worktreeSnapshot, { force: true });
  } catch {
    // Best-effort refresh: persist the last captured state.
  }
  if (tracker.sealed) await persistTurnSnapshotRecord(ownerSessionId, tracker);
}

/** Reverse-apply (`reverse`) or forward-apply the record files `targets`
 *  against the current disk, all-or-nothing: `git apply` checks every hunk
 *  (every binary file's exact bytes) before it writes, so an overlapping
 *  foreign edit fails the whole call and nothing is overwritten. Then their
 *  state is recorded. Resolves to the updated record. */
async function mutateRecordFiles(ownerSessionId, record, targets, reverse) {
  const verb = reverse ? 'undone' : 'reapplied';
  const checkpointId = clean(record.checkpointId);
  const blocked = targets.find((entry) => entry.revertable !== true);
  if (blocked) {
    throw new Error(`${blocked.path} cannot be ${verb}: ${blocked.reason || 'no replayable patch was recorded'}`);
  }
  await applyTurnChangeFiles(record, targets, { reverse });
  // State lands only after git applied every target; a state that cannot
  // land takes the worktree change back with it.
  const keys = new Set(targets.map((entry) => changePathKey(entry.path)));
  let updated;
  try {
    updated = await writeTurnChangeState(ownerSessionId, checkpointId, keys, reverse ? 'reverted' : 'applied');
  } catch (error) {
    try {
      await applyTurnChangeFiles(record, targets, { reverse: !reverse });
    } catch (rollbackError) {
      await markTurnChangeStateUnknown(ownerSessionId, checkpointId, keys);
      await refreshLatestTurnReview(ownerSessionId, record, targets, reverse);
      throw new Error(
        `turn changes were ${verb} but could not be recorded (${error.message}), and restoring the worktree failed (${rollbackError.message}); Undo/Reapply of those files is disabled`,
        { cause: error }
      );
    }
    throw error;
  }
  await refreshLatestTurnReview(ownerSessionId, record, targets, reverse);
  return updated;
}

/** Undo (`reverse`) or Reapply one file or the whole turn, all-or-nothing. */
async function mutateTurnChanges(sessionId, checkpointIdValue, fileValue, revision, reverse) {
  const ownerSessionId = clean(sessionId);
  if (!ownerSessionId) throw new Error('turn changes are unavailable without a session');
  const checkpointId = requiredCheckpointId(checkpointIdValue);
  if (!Number.isSafeInteger(revision)) throw new TypeError('revision must be an integer');
  const file = fileValue === null || fileValue === undefined ? null : clean(fileValue);
  const verb = reverse ? 'undone' : 'reapplied';
  return await serializeChangeMutation(ownerSessionId, async () => {
    if (sessionTurnBusy(ownerSessionId)) {
      throw new Error('turn changes cannot change while this session is running a turn');
    }
    const record = withUnknownChangeStates(ownerSessionId, await loadTurnChangeRecord(ownerSessionId, checkpointId));
    if (!record) throw new Error('turn changes are unavailable: no record for this turn');
    if (Number(record.revision) !== revision) throw new Error('turn changes changed; refresh');
    const from = reverse ? 'applied' : 'reverted';
    let targets;
    if (file) {
      const match = findChangeFile(record, file);
      if (!match) throw new Error(`${file} is not part of this turn's changes`);
      if (fileState(match) !== from) throw new Error(`${match.path} is already ${verb}`);
      targets = [match];
    } else {
      targets = (record.files || []).filter((entry) => fileState(entry) === from);
      if (targets.length === 0) throw new Error(`this turn has no changes to be ${verb}`);
    }
    const updated = await mutateRecordFiles(ownerSessionId, record, targets, reverse);
    const reply = turnChangesReply({
      status: updated ? 'ready' : 'missing',
      checkpointId,
      record: withUnknownChangeStates(ownerSessionId, updated),
    });
    // The viewer caches this reply as it caches a read: the same `ignored` flags.
    return updated ? withIgnoredChangeFiles(ownerSessionId, reply) : reply;
  });
}

/** Reverse-apply one recorded file (`file`) or every applied file (`null`). */
export function revertTurnChanges(sessionId, checkpointId, file, revision) {
  return mutateTurnChanges(sessionId, checkpointId, file, revision, true);
}

/** Forward-apply one reverted file (`file`) or every reverted file (`null`). */
export function reapplyTurnChanges(sessionId, checkpointId, file, revision) {
  return mutateTurnChanges(sessionId, checkpointId, file, revision, false);
}

/** Permanently delete this session's retained change history — every turn's
 *  change record (patches, file metadata, applied/reverted state), its stored
 *  Git baselines, and the live and latest-turn trackers that would resurface
 *  them — so its reviews answer empty, across a restart too. Edits from the
 *  next turn on are tracked again. Refused while a turn runs or seals; on the
 *  per-session lock, behind any Undo/Reapply. Files, the Git index, commits
 *  and the conversation are never touched. Resolves to `{ turns }`, the
 *  number of turn records deleted. */
export async function clearSessionChangeHistory(sessionId) {
  const ownerSessionId = clean(sessionId);
  if (!ownerSessionId) throw new Error('change history is unavailable without a session');
  return await serializeChangeMutation(ownerSessionId, async () => {
    if (sessionTurnBusy(ownerSessionId)) {
      throw new Error('change history cannot be deleted while this session is running a turn');
    }
    // Invalidate every producer of the old history BEFORE the awaited
    // deletion, so nothing begun before the delete can write it back.
    discardSessionChangeState(ownerSessionId);
    // The session's first-seen baselines go too: later edits start fresh ones.
    const [turns] = await Promise.all([
      clearStoredChangeHistory(ownerSessionId),
      clearSessionBaselines(ownerSessionId),
    ]);
    return { turns };
  });
}

/** Release a Lead session's in-memory change state: a worker bound before
 *  this finds its history epoch moved on (its completion parks nothing), its
 *  parked worker reviews are dropped, and its own and bound worker trackers
 *  are discarded (anything earlier that seals writes nothing). */
function discardSessionChangeState(ownerSessionId) {
  _historyEpochs.set(ownerSessionId, (_historyEpochs.get(ownerSessionId) || 0) + 1);
  dropParkedWorkerReviews(ownerSessionId);
  for (const [trackedSessionId, tracker] of _diffTrackersBySession) {
    if (trackedSessionId !== ownerSessionId && tracker.ownerSessionId !== ownerSessionId) continue;
    tracker.discarded = true;
    releaseDiffTrackerContent(tracker);
    _diffTrackersBySession.delete(trackedSessionId);
  }
  _turnsBySession.delete(ownerSessionId);
  for (const key of _unknownChangeStates.keys()) {
    if (key.startsWith(`${ownerSessionId}\0`)) _unknownChangeStates.delete(key);
  }
}

/** The session was deleted: release its turn, parked worker reviews and
 *  bound worker trackers (its stored records go with the session purge). */
export function forgetTurnSnapshotSession(sessionId) {
  const ownerSessionId = clean(sessionId);
  if (ownerSessionId) discardSessionChangeState(ownerSessionId);
}

export function _diffTrackerForTest(sessionId) {
  return _diffTrackersBySession.get(clean(sessionId));
}

export function _parkedWorkerReviewsForTest(ownerSessionId) {
  return [...(_parkedWorkerReviews.get(clean(ownerSessionId))?.values() || [])].map(({ key, patch }) => ({
    key,
    patch,
  }));
}

export function _resetTurnSnapshotForTest() {
  _turnsBySession.clear();
  _diffTrackersBySession.clear();
  _pendingFreezes.clear();
  _changeMutations.clear();
  _unknownChangeStates.clear();
  _parkedWorkerReviews.clear();
  _historyEpochs.clear();
  _turnOpenedHookForTest = null;
  _agentTurnSeq = 0;
  _resetTurnWorktreeSnapshotsForTest();
  _resetSessionBaselinesForTest();
}

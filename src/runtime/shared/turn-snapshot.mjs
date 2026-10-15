import { formatPatch } from 'diff';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  _resetTurnWorktreeSnapshotsForTest,
  createTurnWorktreeSnapshot,
  diffTurnWorktreeHead,
  freezeTurnWorktreeChanges,
  noteTurnWorktreeChange,
  refreshTurnWorktreeSnapshot,
  recordTurnWorktreeFileChange,
  resumeTurnWorktreeSnapshot,
  revertTurnWorktreeFile,
  revertTurnWorktreePaths,
  revertTurnWorktreeSnapshot,
} from './turn-worktree-snapshot.mjs';
import {
  clearSessionChangeHistory as clearStoredChangeHistory,
  loadSessionSnapshotRecords,
  loadTurnChangeRecord,
  loadTurnChangeRecords,
  loadTurnReviewSummary,
  loadTurnSnapshotRecord,
  saveTurnReviewSummary,
  saveTurnSnapshotRecord,
  sessionChangeHistoryCleared,
  updateTurnChangeRecord,
  upsertTurnChangeRecord,
} from './turn-snapshot-store.mjs';
import {
  applyTurnChangeFiles,
  changePathKey,
  findChangeFile,
  measureLegacyChangeFile,
  namedChangePatch,
  sessionChangeReview,
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
import { boundReviewPatch } from './review-diff.mjs';
import { PATCH_EDIT_MAX_BYTES } from './bounded-file-read.mjs';
import { cleanString as clean } from './clean.mjs';
import { structuredPatchOffThread } from './line-diff.mjs';

// Turn-scoped review registry.
//
// A Git worktree gets a shadow-index snapshot at turn start,
// then compares that immutable tree with the latest worktree state. This makes
// the headline authoritative for apply_patch, shell, and external edits while
// preserving changes that already existed before the turn. Non-Git worktrees
// retain the exact apply_patch tracker below.
//
// Worker apply_patch trackers remain separate and are frozen into the owning
// Lead turn as attribution metadata. Their stats are never added a second time
// to a worktree snapshot's authoritative totals.

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
// `${sessionId}\0${checkpointId}` → seals in flight. A sealing turn's change
// record is `pending` and its session refuses Undo/Reapply until it lands.
const _pendingFreezes = new Map();
// Per-session Undo/Reapply chain.
const _changeMutations = new Map();
// `${sessionId}\0${checkpointId}` → path keys whose worktree state is unknown
// and whose record could not even be marked so (the store refused every write).
const _unknownChangeStates = new Map();

function trimTurnCache() {
  while (_turnsBySession.size > TURN_CACHE_MAX) {
    const oldest = _turnsBySession.keys().next().value;
    if (oldest === undefined) break;
    _turnsBySession.delete(oldest);
    for (const [sessionId, tracker] of _diffTrackersBySession) {
      if (sessionId === oldest || tracker.ownerSessionId === oldest) {
        _diffTrackersBySession.delete(sessionId);
      }
    }
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

/** Paths the turn's checkpoint diff itself observed. Only an uncontended
 *  worktree can attribute them to this session; a contended one falls back to
 *  the exact tool-owned list. */
function checkpointObservedPaths(tracker) {
  if (!worktreeSnapshotUsable(tracker)) return [];
  const out = [];
  for (const file of tracker.worktreeSnapshot.files || []) {
    if (file?.path) out.push(String(file.path).replace(/\\/g, '/'));
    if (file?.oldPath) out.push(String(file.oldPath).replace(/\\/g, '/'));
  }
  return out;
}

/** Everything this session changed under `root`: the files its own tools
 *  wrote plus every file its checkpoint diffs observed. This is the
 *  attribution the session-wide Diff and the recorded revert scope share. */
function sessionAttributedPaths(root, tracker) {
  const paths = ownedPathsUnder(root, tracker?.ownedPaths);
  if (tracker?.worktreeSnapshot && pathKey(tracker.worktreeSnapshot.root) === pathKey(root)) {
    for (const path of checkpointObservedPaths(tracker)) paths.add(path);
  }
  return paths;
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
    baselineByPath: new Map(),
    currentByPath: new Map(),
    originByCurrentPath: new Map(),
    unifiedDiff: '',
    patchTruncated: false,
    // The unified diff renders off the main thread: `diffPairs` are the pairs
    // still to render for `diffGeneration`, `diffRendering` the render in
    // flight (settledUnifiedDiff awaits it).
    diffGeneration: 0,
    diffPairs: null,
    diffRendering: null,
    worktreeSnapshot: null,
    // Session-owned relative paths. These outlive the before/after buffers on
    // purpose: they are what scopes a revert once the exact content is gone.
    ownedPaths: new Set(),
  };
}

function releaseDiffTrackerContent(tracker) {
  if (!tracker) return;
  tracker.baselineByPath.clear();
  tracker.currentByPath.clear();
  tracker.originByCurrentPath.clear();
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
  for (const entry of tracker.baselineByPath.values()) total += entry.content?.length || 0;
  for (const entry of tracker.currentByPath.values()) total += entry.content?.length || 0;
  return total;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decodeTrackedContent(content) {
  if (content === null) return '';
  try {
    return utf8Decoder.decode(content);
  } catch {
    return null;
  }
}

async function renderTrackedPair(before, after) {
  const oldDisplay = before?.displayPath || after?.displayPath || 'unknown file';
  const newDisplay = after?.displayPath || before?.displayPath || 'unknown file';
  const oldGit = `a/${oldDisplay}`;
  const newGit = `b/${newDisplay}`;
  const oldHeader = before?.content === null ? '/dev/null' : oldGit;
  const newHeader = after?.content === null ? '/dev/null' : newGit;
  let head = `diff --git ${oldGit} ${newGit}\n`;
  if (before?.content === null && after?.content !== null) head += 'new file mode 100644\n';
  else if (before?.content !== null && after?.content === null) head += 'deleted file mode 100644\n';
  const omitted = [before?.content, after?.content].find(isOmittedContent);
  if (omitted) {
    let change = 'changed';
    if (after?.content === null) change = 'deleted';
    else if (before?.content === null) change = 'added';
    return `${head}binary/large file ${change} (${omitted.size} bytes; content not captured)\nBinary files ${oldHeader} and ${newHeader} differ\n`;
  }
  const oldText = decodeTrackedContent(before?.content ?? null);
  const newText = decodeTrackedContent(after?.content ?? null);
  if (oldText === null || newText === null) {
    return `${head}Binary files ${oldHeader} and ${newHeader} differ\n`;
  }
  try {
    const structured = await structuredPatchOffThread(oldHeader, newHeader, oldText, newText, {
      context: 3,
      timeout: 100,
    });
    if (structured) {
      const generated = formatPatch(structured);
      const headerStart = generated.search(/^--- /m);
      if (headerStart >= 0) return `${head}${generated.slice(headerStart).replace(/\n*$/, '\n')}`;
    }
  } catch {
    // A pathological diff timing out must not stall tool completion. Preserve
    // the changed-file identity even when a textual hunk cannot be rendered.
  }
  if (before?.content === null || after?.content === null) return head;
  if (oldDisplay !== newDisplay) {
    return `${head}similarity index 100%\nrename from ${oldDisplay}\nrename to ${newDisplay}\n`;
  }
  return `${head}Binary files ${oldGit} and ${newGit} differ\n`;
}

/** Re-render `tracker.unifiedDiff` from its current pairs. The pairs are taken
 *  now; their diffs render off the main thread, so readers await
 *  settledUnifiedDiff. A newer refresh supersedes a render in flight. */
function refreshUnifiedDiff(tracker) {
  tracker.diffGeneration += 1;
  if (!tracker.valid) {
    tracker.diffPairs = null;
    tracker.diffRendering = null;
    tracker.unifiedDiff = '';
    return;
  }
  const renamePairs = new Map();
  const pairedDestinations = new Set();
  for (const [destinationKey, originKey] of tracker.originByCurrentPath) {
    if (
      destinationKey === originKey ||
      tracker.currentByPath.has(originKey) ||
      !tracker.currentByPath.has(destinationKey) ||
      !tracker.baselineByPath.has(originKey) ||
      tracker.baselineByPath.has(destinationKey)
    ) {
      continue;
    }
    renamePairs.set(originKey, destinationKey);
    pairedDestinations.add(destinationKey);
  }
  const handled = new Set();
  const allKeys = [...new Set([...tracker.baselineByPath.keys(), ...tracker.currentByPath.keys()])].sort(
    (left, right) => {
      const leftEntry = tracker.currentByPath.get(left) || tracker.baselineByPath.get(left);
      const rightEntry = tracker.currentByPath.get(right) || tracker.baselineByPath.get(right);
      return String(leftEntry?.displayPath || left).localeCompare(String(rightEntry?.displayPath || right));
    }
  );
  const pairs = [];
  for (const key of allKeys) {
    if (!handled.add(key) || pairedDestinations.has(key)) continue;
    const destinationKey = renamePairs.get(key);
    if (destinationKey) handled.add(destinationKey);
    const before = tracker.baselineByPath.get(key);
    const after = tracker.currentByPath.get(destinationKey || key);
    if (!before && !after) continue;
    pairs.push([before || null, after || null]);
  }
  const changed = [];
  for (const [before, after] of pairs) {
    const beforeContent = before?.content ?? null;
    const afterContent = after?.content ?? null;
    const samePath = before?.displayPath === after?.displayPath;
    if (samePath && sameContent(beforeContent, afterContent)) continue;
    changed.push([
      before || { displayPath: after?.displayPath, content: null },
      after || { displayPath: before?.displayPath, content: null },
    ]);
  }
  tracker.diffPairs = changed;
  if (!tracker.diffRendering) tracker.diffRendering = renderUnifiedDiff(tracker);
}

/** Render the tracker's latest pairs until no newer refresh superseded them. */
async function renderUnifiedDiff(tracker) {
  for (;;) {
    const generation = tracker.diffGeneration;
    const pairs = tracker.diffPairs;
    const rendered = await Promise.all(pairs.map(([before, after]) => renderTrackedPair(before, after)));
    if (tracker.diffGeneration === generation) {
      const bounded = boundReviewPatch(rendered.join(''), MAX_PATCH_BYTES);
      tracker.unifiedDiff = bounded.patch;
      tracker.patchTruncated = bounded.truncated;
      tracker.diffPairs = null;
      tracker.diffRendering = null;
      return;
    }
    // Invalidated meanwhile: that refresh already cleared the diff.
    if (!tracker.diffPairs) return;
  }
}

/** The tracker's unified diff once every pending render has landed. */
async function settledUnifiedDiff(tracker) {
  while (tracker.diffRendering) await tracker.diffRendering;
  return tracker.unifiedDiff;
}

function trackedPairs(tracker) {
  const pairs = [];
  const handledOrigins = new Set();
  for (const [destinationKey, after] of tracker.currentByPath) {
    const originKey = tracker.originByCurrentPath.get(destinationKey) || destinationKey;
    handledOrigins.add(originKey);
    pairs.push({
      originKey,
      destinationKey,
      before: tracker.baselineByPath.get(originKey) || null,
      after,
    });
  }
  for (const [originKey, before] of tracker.baselineByPath) {
    if (handledOrigins.has(originKey)) continue;
    pairs.push({ originKey, destinationKey: originKey, before, after: null });
  }
  return pairs;
}

function safeTrackedTarget(worktree, value) {
  const root = resolve(clean(worktree));
  const target = isAbsolute(clean(value)) ? resolve(clean(value)) : resolve(root, clean(value));
  const rel = relative(root, target);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('turn review file path is outside the worktree');
  }
  return target;
}

function pairMatchesFile(pair, worktree, file) {
  const requested = safeTrackedTarget(worktree, file);
  return [pair.before, pair.after].some((entry) => {
    if (!entry) return false;
    const values = [entry.path, entry.displayPath].filter(Boolean);
    return values.some((value) => safeTrackedTarget(worktree, value) === requested);
  });
}

async function currentTrackedContent(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('turn review revert only supports regular files');
    }
    return await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function validateTrackedPair(pair, worktree) {
  const omitted = [pair.before?.content, pair.after?.content].find(isOmittedContent);
  if (omitted) {
    const display = pair.before?.displayPath || pair.after?.displayPath || 'unknown file';
    throw new Error(
      `turn review revert is unavailable for ${display}: binary/large file content was not captured (${omitted.size} bytes)`
    );
  }
  const beforePath = safeTrackedTarget(
    worktree,
    pair.before?.path || pair.before?.displayPath || pair.after?.path || pair.after?.displayPath
  );
  const afterPath = safeTrackedTarget(
    worktree,
    pair.after?.path || pair.after?.displayPath || pair.before?.path || pair.before?.displayPath
  );
  const expectedAfter = pair.after?.content ?? null;
  const actualAfter = await currentTrackedContent(afterPath);
  if (!sameContent(actualAfter, expectedAfter)) {
    throw new Error('turn review revert refused because the file changed after this session edit');
  }
  if (beforePath !== afterPath && (await currentTrackedContent(beforePath)) !== null) {
    throw new Error('turn review revert refused because the original path changed after this session edit');
  }
  return { beforePath, afterPath };
}

async function restoreTrackedPair(pair, paths) {
  if (paths.afterPath !== paths.beforePath) await rm(paths.afterPath, { force: true });
  if (pair.before?.content == null) {
    await rm(paths.beforePath, { force: true });
  } else {
    await mkdir(dirname(paths.beforePath), { recursive: true });
    await writeFile(paths.beforePath, pair.before.content);
  }
}

function commitTrackedPairRestore(tracker, pair) {
  tracker.currentByPath.delete(pair.destinationKey);
  tracker.currentByPath.delete(pair.originKey);
  tracker.originByCurrentPath.delete(pair.destinationKey);
  tracker.originByCurrentPath.delete(pair.originKey);
  if (pair.before) tracker.currentByPath.set(pair.originKey, { ...pair.before });
}

async function revertTrackedPairs(tracker, worktree, pairs) {
  if (!tracker?.valid || pairs.length === 0) {
    throw new Error('turn review tracked file snapshot is unavailable');
  }
  // Validate every current file before the first write so an external edit
  // cannot leave a turn-wide revert half-applied.
  const validated = [];
  for (const pair of pairs) validated.push(await validateTrackedPair(pair, worktree));
  for (let index = 0; index < pairs.length; index += 1) {
    await restoreTrackedPair(pairs[index], validated[index]);
    commitTrackedPairRestore(tracker, pairs[index]);
  }
  tracker.revision += 1;
  refreshUnifiedDiff(tracker);
  if (!(await settledUnifiedDiff(tracker))) releaseDiffTrackerContent(tracker);
  // The absolute paths now back at their turn-start bytes.
  return [...new Set(validated.flatMap(({ beforePath, afterPath }) => [beforePath, afterPath]))];
}

/** A path's first observed state is its baseline; later changes never replace it. */
function recordFirstBaseline(tracker, key, entry) {
  if (!tracker.currentByPath.has(key) && !tracker.baselineByPath.has(key)) tracker.baselineByPath.set(key, entry);
}

/**
 * Fold exact committed before/after file states into a session's current turn.
 * A change is `{ path, displayPath, before, after }`; a rename additionally
 * carries `{ newPath, newDisplayPath }`. The changes fold in synchronously;
 * the returned promise resolves to the turn's unified diff once it rendered.
 */
export function recordTurnDiffChanges(sessionId, changes = []) {
  if (DISABLED) return Promise.resolve('');
  const id = clean(sessionId);
  if (!id) return Promise.resolve('');
  const tracker = _diffTrackersBySession.get(id) || resetDiffTracker(id);
  const list = Array.isArray(changes) ? changes : [];
  const ownerTracker = tracker?.ownerSessionId ? _diffTrackersBySession.get(tracker.ownerSessionId) : tracker;
  const snapshot = ownerTracker?.worktreeSnapshot;
  // Independent of this tracker's validity: the session review needs every
  // write's first-seen state even once the turn's buffers are gone.
  captureReviewBaselines(id, tracker, ownerTracker, list, snapshot);
  if (!tracker) return Promise.resolve('');
  if (tracker.valid && !tracker.sealed) foldTrackedChanges(tracker, list, snapshot);
  return settledUnifiedDiff(tracker);
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

/** Fold exact before/after states into `tracker`. `snapshot` — the owning
 *  Lead turn's Git baseline, when tools are writing — learns each written
 *  path's first-before bytes. */
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
    tracker.ownedPaths.add(ownedPathEntry(sourcePath, sourceDisplay));
    if (destinationPath) {
      tracker.ownedPaths.add(ownedPathEntry(destinationPath, displayPath(raw?.newDisplayPath || destinationPath)));
    }
    if (!storeContent) continue;
    const after = contentBuffer(raw?.after);
    if (!destinationPath) {
      if (before === null && after !== null) {
        tracker.originByCurrentPath.delete(sourceKey);
        tracker.currentByPath.set(sourceKey, {
          path: sourcePath,
          displayPath: sourceDisplay,
          content: after,
        });
        continue;
      }
      if (before !== null && after === null) {
        if (!tracker.currentByPath.delete(sourceKey) && !tracker.baselineByPath.has(sourceKey)) {
          tracker.baselineByPath.set(sourceKey, {
            path: sourcePath,
            displayPath: sourceDisplay,
            content: before,
          });
        }
        tracker.originByCurrentPath.delete(sourceKey);
        continue;
      }
      if (before === null && after === null) continue;
      recordFirstBaseline(tracker, sourceKey, { path: sourcePath, displayPath: sourceDisplay, content: before });
      tracker.currentByPath.set(sourceKey, {
        path: sourcePath,
        displayPath: sourceDisplay,
        content: after,
      });
      continue;
    }

    const destinationKey = pathKey(destinationPath);
    const destinationDisplay = displayPath(raw?.newDisplayPath || destinationPath);
    recordFirstBaseline(tracker, sourceKey, { path: sourcePath, displayPath: sourceDisplay, content: before });
    const originKey = tracker.originByCurrentPath.get(sourceKey) || sourceKey;
    tracker.currentByPath.delete(sourceKey);
    tracker.originByCurrentPath.delete(sourceKey);
    tracker.currentByPath.set(destinationKey, {
      path: destinationPath,
      displayPath: destinationDisplay,
      content: after,
    });
    tracker.originByCurrentPath.delete(destinationKey);
    if (destinationKey !== originKey) tracker.originByCurrentPath.set(destinationKey, originKey);
  }
  tracker.revision += 1;
  if (trackedContentBytes(tracker) > MAX_TRACKED_CONTENT_BYTES) {
    tracker.valid = false;
    releaseDiffTrackerContent(tracker);
  }
  refreshUnifiedDiff(tracker);
}

/** Evict the oldest worker reviews over the turn's budget; true if any went. */
function trimAgentReviews(turn) {
  const retainedBytes = () =>
    [...turn.agents.values()].reduce((total, review) => total + Buffer.byteLength(review.patch || '', 'utf8'), 0);
  let evicted = false;
  while (turn.agents.size > MAX_AGENT_REVIEWS_PER_TURN || retainedBytes() > MAX_AGENT_REVIEW_BYTES_PER_TURN) {
    const oldest = turn.agents.keys().next().value;
    if (oldest === undefined) break;
    turn.agents.delete(oldest);
    evicted = true;
  }
  return evicted;
}

/** The turn's worker reviews once every completed worker's diff text landed. */
async function publicAgentReviews(sessionId) {
  const turn = _turnsBySession.get(clean(sessionId));
  if (!turn) return [];
  while (turn.agentPatches.size > 0) await Promise.all(turn.agentPatches);
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
  // Late-worker re-seals still queued for the previous turn run first, in
  // this same step — including one a worker queued while an earlier one ran —
  // so the workers' edits stay in that turn's record and nothing the new turn
  // writes can reach it. (A queued re-seal implies a chain.)
  const { token, tracker } = _changeMutations.has(ownerSessionId)
    ? await serializeChangeMutation(ownerSessionId, async () => {
        const previous = _diffTrackersBySession.get(ownerSessionId);
        while (previous?.resealQueued) await runQueuedReseal(ownerSessionId, previous).catch(() => {});
        return openTurnSnapshot(worktree, ownerSessionId, options);
      })
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
  for (const [trackedSessionId, tracker] of _diffTrackersBySession) {
    if (tracker.ownerSessionId === ownerSessionId) _diffTrackersBySession.delete(trackedSessionId);
  }
  _turnsBySession.delete(ownerSessionId);
  _turnsBySession.set(ownerSessionId, {
    generation,
    checkpointId,
    agents: new Map(),
    // Completed workers whose tracked diff text is still rendering.
    agentPatches: new Set(),
  });
  const worktreeRequest = pathKey(worktree);
  const tracker = resetDiffTracker(ownerSessionId, {
    ownerGeneration: generation,
    checkpointId,
    worktreeRequest,
    worktreeRoot: resolve(clean(worktree) || '.'),
  });
  trimTurnCache();
  if (tracker) markWorktreeContention(ownerSessionId, tracker);
  _turnOpenedHookForTest?.(ownerSessionId, checkpointId);
  return { token: { generation, checkpointId }, tracker };
}

// Test seam: runs synchronously the instant a new turn's tracker is installed,
// i.e. the earliest moment that turn could touch the worktree.
let _turnOpenedHookForTest = null;
export function _setTurnOpenedHookForTest(hook) {
  _turnOpenedHookForTest = typeof hook === 'function' ? hook : null;
}

/** Bind one worker execution to the Lead turn that launched it. */
export function beginAgentTurnReview(ownerSessionId, childSessionId, meta = {}) {
  if (DISABLED) return null;
  const owner = clean(ownerSessionId);
  const child = clean(childSessionId);
  // Durable: the worker's edits join the Lead's session review even when it
  // runs its own session turn, and whatever the turn's agent list keeps.
  recordReviewOwner(child, owner);
  const turn = _turnsBySession.get(owner);
  if (!owner || !child || !turn) return null;
  const existingTracker = _diffTrackersBySession.get(child);
  if (
    !existingTracker ||
    existingTracker.ownerSessionId !== owner ||
    existingTracker.ownerGeneration !== turn.generation
  ) {
    resetDiffTracker(child, {
      ownerSessionId: owner,
      ownerGeneration: turn.generation,
    });
  }
  _agentTurnSeq += 1;
  return {
    id: `agent-review-${_agentTurnSeq}`,
    ownerSessionId: owner,
    generation: turn.generation,
    sessionId: child,
    agent: clean(meta.agent) || null,
    tag: clean(meta.tag) || null,
    completed: false,
  };
}

/** Freeze successful worker apply_patch diffs into their owning Lead turn.
 *  Everything a seal reads — the agent entry, the worker's owned paths and a
 *  late re-seal — is published synchronously, so a seal started right after
 *  this call already includes the worker. Only the text of a tracked diff
 *  still rendering off the main thread lands later; the returned promise and
 *  every live review read wait for it. */
export async function completeAgentTurnReview(handle, patches = []) {
  if (!handle || handle.completed === true) return false;
  handle.completed = true;
  const ownerSessionId = clean(handle.ownerSessionId);
  const key = clean(handle.sessionId) || handle.id;
  const turn = _turnsBySession.get(ownerSessionId);
  const tracker = _diffTrackersBySession.get(key);
  const matchingTracker =
    tracker && tracker.ownerSessionId === ownerSessionId && tracker.ownerGeneration === handle.generation;
  // A worker that runs its own session turn replaces the bound tracker with
  // its turn's own one (no owner). beginAgentTurnReview reset any older
  // tracker, so an unowned one here holds this execution's edits.
  const source = matchingTracker || (tracker && !tracker.ownerSessionId) ? tracker : null;
  const ownerTracker = _diffTrackersBySession.get(ownerSessionId);
  // A worker that finishes after its Lead turn sealed (or while it seals)
  // re-seals that turn's change record (its edits are part of the turn's net
  // worktree diff).
  const resealOwner = () => {
    if (ownerTracker && ownerTracker !== tracker && ownerTracker.ownerGeneration === handle.generation) {
      resealTurn(ownerSessionId, ownerTracker);
    }
  };
  let filled = null;
  try {
    if (!turn || turn.generation !== handle.generation) return false;
    const prior = turn.agents.get(key);
    const tracked = Boolean(source) && source.revision > 0;
    // A render still in flight resolves to text exactly when it has changed pairs.
    const rendering = tracked && Boolean(source.diffRendering);
    const patch = tracked ? source.unifiedDiff : mergePatches(patches);
    if (rendering ? source.diffPairs.length === 0 : !patch) {
      if (tracked && prior) {
        turn.agents.delete(key);
        return true;
      }
      return false;
    }
    const review = {
      sessionId: key,
      agent: handle.agent || prior?.agent || null,
      tag: handle.tag || prior?.tag || null,
      patch: tracked ? (rendering ? '' : patch) : mergePatches([prior?.patch, patch]),
    };
    turn.agents.delete(key);
    turn.agents.set(key, review);
    if (source && ownerTracker && ownerTracker !== source) {
      for (const path of source.ownedPaths) ownerTracker.ownedPaths.add(path);
    }
    trimAgentReviews(turn);
    resealOwner();
    if (!rendering) return true;
    filled = settledUnifiedDiff(source).then((text) => {
      review.patch = text;
      // The text joins the byte budget only now; an eviction re-seals too.
      if (trimAgentReviews(turn) && _turnsBySession.get(ownerSessionId) === turn) resealOwner();
    });
    turn.agentPatches.add(filled);
  } finally {
    if (matchingTracker && _diffTrackersBySession.get(key) === tracker) {
      releaseDiffTrackerContent(tracker);
      _diffTrackersBySession.delete(key);
    }
  }
  try {
    await filled;
  } finally {
    turn.agentPatches.delete(filled);
  }
  return true;
}

/** Persist the durable half of a finished review: the baseline tree hash plus
 *  the paths this session owns. Memory keeps the fast path; the record is what
 *  survives the next turn, a cache eviction and a runtime restart. A CONTENDED
 *  worktree is recorded too — the baseline is still exact, and the owned paths
 *  are precisely the attribution that contention destroys. */
async function persistTurnSnapshotRecord(ownerSessionId, tracker) {
  const snapshot = tracker?.worktreeSnapshot;
  if (!ownerSessionId || tracker.discarded || !snapshot?.baselineTree || !snapshot.root) return;
  const owned = [...sessionAttributedPaths(snapshot.root, tracker)];
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

/** Path of a tracked entry relative to `root`, or '' outside it. */
function trackedRelativePath(root, entry) {
  const value = clean(entry?.path) || clean(entry?.displayPath);
  if (!value) return '';
  const rel = relative(root, isAbsolute(value) ? resolve(value) : resolve(root, value));
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) return '';
  return rel.replace(/\\/g, '/');
}

/** A record file for an edit the worktree root cannot replay: outside it, or
 *  too large/binary to capture. Display-only (`viewPatch`), never undone. */
async function untrackableRecordFile(pair, { before, after, oldPath, newPath, omitted }) {
  let status = 'M';
  if (before === null) status = 'A';
  else if (after === null) status = 'D';
  else if (oldPath !== newPath) status = 'R';
  const shownPath =
    (status === 'D' ? oldPath : newPath) || displayPath(pair.after?.displayPath || pair.before?.displayPath);
  const named = omitted ? null : await namedChangePatch({ before, after, oldName: shownPath, newName: shownPath });
  return {
    path: shownPath,
    ...(status === 'R' && oldPath ? { oldPath } : {}),
    status,
    additions: named?.additions || 0,
    deletions: named?.deletions || 0,
    ...(named?.patch ? { viewPatch: named.patch } : {}),
    ...(omitted ? { binary: true } : {}),
    revertable: false,
    reason: omitted ? 'binary/large file content was not captured' : 'file is outside the recorded root',
  };
}

/** The exact before/after pair of a tracked entry, or null when it changed nothing. */
function recordedPair(pair, root) {
  const before = pair.before?.content ?? null;
  const after = pair.after?.content ?? null;
  if (before === null && after === null) return null;
  const oldPath = trackedRelativePath(root, pair.before || pair.after);
  const newPath = trackedRelativePath(root, pair.after || pair.before);
  if (oldPath === newPath && sameContent(before, after)) return null;
  return { before, after, oldPath, newPath, omitted: [before, after].some(isOmittedContent) };
}

/** Record files of a non-Git turn, from the exact apply_patch buffers (in
 *  pair order; their diffs run off the main thread). */
async function trackedRecordFiles(tracker, root) {
  if (!tracker.valid) {
    return [...ownedPathsUnder(root, tracker.ownedPaths)].map((path) => ({
      path,
      status: 'M',
      additions: 0,
      deletions: 0,
      revertable: false,
      reason: 'file content exceeded the undo tracking limit',
    }));
  }
  const files = [];
  for (const pair of trackedPairs(tracker)) {
    const edit = recordedPair(pair, root);
    if (!edit) continue;
    if (edit.omitted || !edit.oldPath || !edit.newPath) {
      files.push(untrackableRecordFile(pair, edit));
      continue;
    }
    files.push(
      trackedChangeFile({ oldPath: edit.oldPath, newPath: edit.newPath, before: edit.before, after: edit.after })
    );
  }
  return await Promise.all(files);
}

/** Edits of a Git turn that lie outside its worktree root: the baseline diff
 *  never sees them, so they are recorded view-only beside the Git files. */
async function outsideRecordFiles(tracker, root) {
  if (!tracker.valid) return [];
  const files = [];
  for (const pair of trackedPairs(tracker)) {
    const edit = recordedPair(pair, root);
    if (edit && (!edit.oldPath || !edit.newPath)) {
      files.push(untrackableRecordFile(pair, edit));
    }
  }
  return await Promise.all(files);
}

/** Freeze the turn's net diff into its durable change record. A Git turn
 *  records the baseline→end worktree diff (workers' edits included, scoped to
 *  session-owned paths when the worktree is shared); a non-Git turn records
 *  the Lead's exact apply_patch pairs. */
async function freezeTurnChanges(ownerSessionId, tracker, agents) {
  const checkpointId = clean(tracker.checkpointId);
  if (!checkpointId) return null;
  let frozen = null;
  if (tracker.worktreeSnapshot) {
    const scope = worktreeSnapshotUsable(tracker)
      ? null
      : [...ownedPathsUnder(tracker.worktreeSnapshot.root, tracker.ownedPaths)];
    const result = await freezeTurnWorktreeChanges(tracker.worktreeSnapshot, scope);
    if (result) {
      frozen = { kind: 'git', ...result, outside: await outsideRecordFiles(tracker, tracker.worktreeSnapshot.root) };
    }
  } else if (tracker.worktreeRoot) {
    frozen = {
      kind: 'tracked',
      root: tracker.worktreeRoot,
      files: await trackedRecordFiles(tracker, tracker.worktreeRoot),
    };
  }
  if (!frozen) return null;
  const record = await upsertTurnChangeRecord(ownerSessionId, {
    checkpointId,
    kind: frozen.kind,
    root: frozen.root,
    agents,
    files: frozen.files.map(storedChangeFile),
    outside: (frozen.outside || []).map(storedChangeFile),
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
 * completion wake reopened the turn meanwhile. `reseal` (a late worker) only
 * re-freezes a turn that is still sealed, after any seal in flight: that one
 * captured its agents before the worker was attributed.
 */
function sealTurn(ownerSessionId, tracker, { reseal = false } = {}) {
  // Its history was deleted (clearSessionChangeHistory): never written again.
  if (tracker.discarded) return Promise.resolve();
  if (tracker.freezing) {
    if (reseal) return tracker.freezing.then(() => sealTurn(ownerSessionId, tracker, { reseal: true }));
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
    if (tracker.discarded || tracker.sealEpoch !== epoch || (reseal && !tracker.sealed)) return;
    // A re-seal never rewrites a turn once the next one opened.
    if (reseal && turnSuperseded(ownerSessionId, tracker)) return;
    tracker.sealed = true;
    await persistTurnSnapshotRecord(ownerSessionId, tracker);
    try {
      if (!tracker.discarded) await freezeTurnChanges(ownerSessionId, tracker, agents);
    } catch {
      /* the change record adds Undo history; it never fails a turn */
    }
    // Only a usable Git baseline can replace the exact apply_patch buffers. A
    // contended worktree — and a worktree with no Git baseline at all — retains
    // this session's bounded before/after content so Review can still undo its
    // own files after the turn completes.
    if (worktreeSnapshotUsable(tracker)) releaseDiffTrackerContent(tracker);
  })().finally(() => {
    if (tracker.freezing === run) tracker.freezing = null;
    const count = (_pendingFreezes.get(key) || 1) - 1;
    if (count > 0) _pendingFreezes.set(key, count);
    else _pendingFreezes.delete(key);
  });
  tracker.freezing = run;
  return run;
}

function resealTurn(ownerSessionId, tracker) {
  // A turn still running seals with every published agent; one sealed or
  // sealing queues its re-seal (sealTurn runs it after a seal in flight).
  if (!(tracker.sealed || tracker.freezing) || !clean(tracker.checkpointId) || tracker.resealQueued) return;
  // On the session lock: an in-flight Undo/Reapply lands before the re-freeze
  // reads the worktree. A turn start queued ahead of it runs it before opening
  // (beginTurnSnapshot), so one queued re-seal covers every late worker.
  tracker.resealQueued = true;
  void serializeChangeMutation(ownerSessionId, () => runQueuedReseal(ownerSessionId, tracker)).catch(() => {});
}

/** True once a newer turn of the session opened over `tracker`'s. */
function turnSuperseded(ownerSessionId, tracker) {
  const turn = _turnsBySession.get(ownerSessionId);
  return Boolean(turn) && turn.generation !== tracker.ownerGeneration;
}

/** Run `tracker`'s queued re-seal once, whichever lock step reaches it first. */
function runQueuedReseal(ownerSessionId, tracker) {
  if (!tracker.resealQueued) return undefined;
  tracker.resealQueued = false;
  if (turnSuperseded(ownerSessionId, tracker)) return undefined;
  return sealTurn(ownerSessionId, tracker, { reseal: true });
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

/**
 * Can this turn's Git baseline own the review and its revert? A contended
 * worktree cannot attribute concurrent mutations to one session, and a
 * non-Git worktree never had a baseline to begin with. In both cases the
 * exact apply_patch buffers are the only safe revert source.
 */
function worktreeSnapshotUsable(tracker) {
  return Boolean(tracker && !tracker.worktreeContended && tracker.worktreeSnapshot);
}

/** Match a user-supplied file against a recorded session-owned path. */
function recordedPathMatchesFile(owned, root, file) {
  const target = clean(file);
  if (!target) return false;
  const normalizedRoot = pathKey(root);
  const normalizedTarget = pathKey(target);
  const relativeTarget =
    normalizedRoot && normalizedTarget.startsWith(`${normalizedRoot}/`)
      ? normalizedTarget.slice(normalizedRoot.length + 1)
      : normalizedTarget;
  const normalizedOwned = pathKey(owned);
  return normalizedOwned === relativeTarget || normalizedOwned === normalizedTarget;
}

/** Re-open the recorded baseline for a session whose tracker is gone. Returns
 *  null when the record is missing or its tree object has been collected. */
async function resumeRecordedSnapshot(ownerSessionId, { omitPatch = false } = {}) {
  if (!ownerSessionId) return null;
  let record = null;
  try {
    record = await loadTurnSnapshotRecord(ownerSessionId);
  } catch {
    return null;
  }
  if (!record) return null;
  const snapshot = await resumeTurnWorktreeSnapshot(record.root, record.baselineTree, {
    paths: record.toolFiles,
    baselineFiles: record.baselineFiles,
    omitPatch,
  }).catch(() => null);
  if (!snapshot) return null;
  return { record, snapshot };
}

/** A review rebuilt from the durable record. Same shape as the live one, but
 *  scoped to the recording session's own paths so a worktree shared with other
 *  sessions stays attributable instead of losing its revert entirely. */
async function scopedReviewFromRecord(ownerSessionId, { omitPatch = false } = {}) {
  const resumed = await resumeRecordedSnapshot(ownerSessionId, { omitPatch });
  if (!resumed) return null;
  void saveTurnReviewSummary(ownerSessionId, resumed.record, resumed.snapshot);
  return {
    supported: true,
    files: resumed.snapshot.files || [],
    patch: resumed.snapshot.patch || '',
    ...(resumed.snapshot.patchOmitted ? { patchOmitted: true } : {}),
    snapshotKind: 'scoped',
    revertMode: 'scoped',
    checkpointId: clean(resumed.record.checkpointId),
    patchTruncated: resumed.snapshot.patchTruncated === true,
    authoritative: true,
    agents: await publicAgentReviews(ownerSessionId),
    reason: 'recorded',
  };
}

/** The files and counts last computed from the durable record, without
 *  rescanning the worktree. `cached` (not `recorded`): the caller's
 *  refreshing read still follows and replaces it. */
async function cachedReviewFromRecord(ownerSessionId) {
  const record = await loadTurnSnapshotRecord(ownerSessionId).catch(() => null);
  const cached = record ? await loadTurnReviewSummary(ownerSessionId, record) : null;
  if (!cached) return null;
  return {
    supported: true,
    files: cached.files,
    patch: '',
    patchOmitted: true,
    snapshotKind: 'scoped',
    revertMode: 'scoped',
    checkpointId: clean(record.checkpointId),
    patchTruncated: cached.patchTruncated === true,
    authoritative: true,
    agents: await publicAgentReviews(ownerSessionId),
    reason: 'cached',
  };
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

/** Restore recorded paths — every one of them, or just the file the user picked. */
async function revertFromRecord(ownerSessionId, file, expectedCheckpointId) {
  const resumed = await resumeRecordedSnapshot(ownerSessionId);
  if (!resumed) return null;
  assertCheckpointMatches(expectedCheckpointId, resumed.record.checkpointId);
  const owned = resumed.record.toolFiles;
  const targets = file ? owned.filter((path) => recordedPathMatchesFile(path, resumed.record.root, file)) : owned;
  if (targets.length === 0) {
    throw new Error('turn review revert cannot attribute this file to the session');
  }
  const paths = await revertTurnWorktreePaths(resumed.snapshot, targets);
  return { checkpointId: clean(resumed.record.checkpointId), paths };
}

/** Return the authoritative Lead net diff plus attributed child reviews. */
export async function getTurnReviewDiff(_worktree, sessionId, options = {}) {
  if (DISABLED) return { supported: false, files: [], patch: '', agents: [] };
  const ownerSessionId = clean(sessionId);
  const turn = _turnsBySession.get(ownerSessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  const isolatedWorktreeSnapshot = worktreeSnapshotUsable(tracker) ? tracker.worktreeSnapshot : null;
  if (isolatedWorktreeSnapshot && !tracker.sealed && options.refresh !== false) {
    // Only the review bar's interval timer sends `poll: 'background'`; an
    // open review (asking for its patch, no `summary`) keeps a short gap.
    // Every other read (opening the review, a manual or tool-boundary
    // refresh, a client that sends no `poll`) captures the worktree now.
    const refreshOptions = options.poll === 'background' ? { visible: options.summary !== true } : { force: true };
    try {
      await refreshTurnWorktreeSnapshot(isolatedWorktreeSnapshot, refreshOptions);
    } catch {
      // Best-effort refresh: the review reads the last captured state.
    }
  }
  const snapshot = isolatedWorktreeSnapshot;
  // Without a usable baseline the review falls back to this session's own
  // mutations — including a worktree that has no Git repository at all, which
  // used to leave the bar with no revert mode whatsoever.
  const trackedRevertAvailable = !snapshot && tracker?.valid === true && trackedPairs(tracker).length > 0;
  if (!snapshot && !trackedRevertAvailable) {
    // Both in-memory sources are gone: the next turn replaced the tracker, the
    // turn cache evicted it, or the runtime restarted. The recorded baseline is
    // still on disk and still exact. Rebuilt per read and then discarded, so a
    // summary read skips its patch text instead of dropping it afterwards.
    // A collapsed read that asked for no refresh (entering the session) takes
    // the last computed summary instead of queueing a rescan.
    if (options.refresh === false && options.summary === true) {
      const cached = await cachedReviewFromRecord(ownerSessionId);
      if (cached) return cached;
    }
    const recorded = await scopedReviewFromRecord(ownerSessionId, { omitPatch: options.summary === true });
    if (recorded) return recorded;
  }
  if (!snapshot && tracker) await settledUnifiedDiff(tracker);
  let revertMode = '';
  if (snapshot) revertMode = 'worktree';
  else if (trackedRevertAvailable) revertMode = 'tracked';
  return {
    supported: true,
    files: snapshot?.files || [],
    patch: snapshot?.patch ?? tracker?.unifiedDiff ?? '',
    snapshotKind: snapshot ? 'worktree' : 'tool',
    revertMode,
    checkpointId: clean(turn?.checkpointId || tracker?.checkpointId),
    patchTruncated: (snapshot || tracker)?.patchTruncated === true,
    authoritative: Boolean(turn && tracker),
    agents: await publicAgentReviews(ownerSessionId),
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
  const merged = await sessionChangeReview(review, { baselines, records });
  // `historyTurns`: the retained turn records clearSessionChangeHistory deletes.
  return { ...merged, historyTurns: records.length };
}

async function baselineSessionReviewDiff(worktree, ownerSessionId) {
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  const scopes = await loadSessionSnapshotRecords(ownerSessionId).catch(() => []);
  const stored = scopes.find((scope) => scopeMatchesWorktree(scope, worktree, tracker));
  const root = stored?.root || tracker?.worktreeSnapshot?.root || clean(worktree);
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
  const ownedPaths = new Set(stored?.toolFiles || []);
  for (const path of sessionAttributedPaths(root, tracker)) ownedPaths.add(path);
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
  const baselineTree = stored?.baselineTree || tracker?.worktreeSnapshot?.baselineTree;
  if (root && baselineTree) {
    const baselineFiles = new Map((stored?.baselineFiles || []).map((entry) => [pathKey(entry.path), entry]));
    const storedPaths = new Set((stored?.toolFiles || []).map(pathKey));
    for (const entry of tracker?.worktreeSnapshot?.baselineFiles.values() || []) {
      if (!storedPaths.has(pathKey(entry.path))) baselineFiles.set(pathKey(entry.path), entry);
    }
    const snapshot = await resumeTurnWorktreeSnapshot(root, baselineTree, {
      paths: [...ownedPaths],
      baselineFiles: [...baselineFiles.values()],
    }).catch(() => null);
    if (snapshot) {
      // The island counts only what is still uncommitted: the owned files
      // that differ from HEAD now, measured against HEAD.
      const uncommittedFiles = await diffTurnWorktreeHead(snapshot, [...ownedPaths]).catch(() => null);
      return {
        supported: true,
        root,
        files: snapshot.files || [],
        patch: snapshot.patch || '',
        patchTruncated: snapshot.patchTruncated === true,
        snapshotKind: 'session',
        authoritative: true,
        source: 'git',
        ...(uncommittedFiles ? { uncommittedFiles } : {}),
      };
    }
  }
  // A non-Git first turn still has an exact apply_patch tracker. It cannot
  // cross a runtime restart, but remains preferable to widening into unrelated
  // files from the surrounding directory.
  // `owned` lets the session review flag an owned file no other source knows.
  if (tracker?.valid) {
    const patch = await settledUnifiedDiff(tracker);
    return {
      supported: true,
      root,
      files: [],
      patch: patch || '',
      patchTruncated: tracker.patchTruncated === true,
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

/** Why this turn cannot revert through its exact apply_patch buffers. */
function unavailableTrackedRevertReason(tracker) {
  return tracker.worktreeContended
    ? 'turn review revert is unavailable while sessions share a worktree'
    : 'turn review tracked file snapshot is unavailable';
}

/** Restore the latest turn — every file it can attribute (`whole`) or the one
 *  the user picked — to its turn-start state. Resolves to the restored turn's
 *  checkpoint and the absolute paths actually restored: a contended worktree
 *  restores only the Lead's own tracked files, never its workers'. */
async function revertLatestTurnUnlocked(worktree, ownerSessionId, file, whole, expectedCheckpointId) {
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (tracker) assertCheckpointMatches(expectedCheckpointId, tracker.checkpointId);
  const restored = (paths) => ({ checkpointId: clean(tracker.checkpointId), paths });
  const recordFile = whole ? null : file;
  if (tracker && !worktreeSnapshotUsable(tracker)) {
    const pairs = trackedPairs(tracker);
    if (pairs.length > 0) {
      let selected = pairs;
      if (!whole) {
        const pair = pairs.find((entry) => pairMatchesFile(entry, worktree, file));
        if (!pair) throw new Error('turn review tracked file snapshot is unavailable');
        selected = [pair];
      }
      return restored(await revertTrackedPairs(tracker, worktree, selected));
    }
    const recorded = await revertFromRecord(ownerSessionId, recordFile, expectedCheckpointId);
    if (recorded) return recorded;
    throw new Error(unavailableTrackedRevertReason(tracker));
  }
  if (tracker?.worktreeSnapshot) {
    return restored(
      whole
        ? await revertTurnWorktreeSnapshot(tracker.worktreeSnapshot)
        : await revertTurnWorktreeFile(tracker.worktreeSnapshot, file)
    );
  }
  const recorded = await revertFromRecord(ownerSessionId, recordFile, expectedCheckpointId);
  if (recorded) return recorded;
  throw new Error('turn worktree snapshot is unavailable');
}

/** Record a composer restore in the turn's change record: a record file whose
 *  every side (a rename's old path too) was restored is back at its
 *  turn-start bytes, i.e. `reverted`; every other file keeps its state. */
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
function revertLatestTurn(worktree, sessionId, file, whole, expectedCheckpointId) {
  const ownerSessionId = clean(sessionId);
  return serializeChangeMutation(ownerSessionId, async () => {
    // A seal still freezing would record the pre-restore disk after this.
    const freezing = _diffTrackersBySession.get(ownerSessionId)?.freezing;
    if (freezing) await freezing.catch(() => {});
    const restored = await revertLatestTurnUnlocked(worktree, ownerSessionId, file, whole, expectedCheckpointId);
    await recordComposerRevert(ownerSessionId, restored);
    return await getTurnReviewDiff(worktree, ownerSessionId);
  });
}

/** Restore one reviewed file to this turn's worktree baseline, never to HEAD. */
export function revertTurnReviewFile(worktree, sessionId, file, expectedCheckpointId = '') {
  return revertLatestTurn(worktree, sessionId, file, false, expectedCheckpointId);
}

/** Restore every file in the reviewed turn to its turn-start state. */
export function revertTurnReview(worktree, sessionId, expectedCheckpointId = '') {
  return revertLatestTurn(worktree, sessionId, null, true, expectedCheckpointId);
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
    record = {
      ...record,
      files: await Promise.all(record.files.map((file) => measureLegacyChangeFile(file, record.root))),
    };
  }
  let status = 'missing';
  if (ownerSessionId && turnChangesPending(ownerSessionId, checkpointId)) status = 'pending';
  else if (record) status = record.files?.length || record.outside?.length ? 'ready' : 'none';
  return turnChangesReply({
    status,
    checkpointId,
    record,
    patch: options?.patch === true,
    file: clean(options?.file) || null,
  });
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

/** The exact-buffer review tracker (non-Git or contended worktree) an
 *  Undo/Reapply must fold into, with the pre-mutation bytes of every moved
 *  file under the tracker's root. Null when the review has a usable Git
 *  baseline (it re-captures instead) or nothing to fold. */
async function trackedReviewFold(ownerSessionId, root, targets, reverse) {
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (!tracker?.valid || worktreeSnapshotUsable(tracker) || !tracker.worktreeRoot) return null;
  const inside = (path) => {
    const rel = relative(tracker.worktreeRoot, path);
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
  };
  const moves = [];
  for (const entry of targets) {
    const path = resolve(root, entry.path);
    const oldPath = entry.oldPath ? resolve(root, entry.oldPath) : path;
    const move = reverse ? { source: path, destination: oldPath } : { source: oldPath, destination: path };
    if (inside(move.source) && inside(move.destination)) moves.push(move);
  }
  if (moves.length === 0) return null;
  try {
    for (const move of moves) move.before = await currentTrackedContent(move.source);
  } catch {
    return { tracker, moves, unreadable: true };
  }
  return { tracker, moves };
}

/** One moved file as a tracked change: its pre-mutation bytes and what the
 *  mutation left at its destination. */
async function movedFileChange(root, move) {
  const change = {
    path: move.source,
    displayPath: trackedRelativePath(root, { path: move.source }),
    before: move.before,
    after: await currentTrackedContent(move.destination),
  };
  if (move.destination === move.source) return change;
  return {
    ...change,
    newPath: move.destination,
    newDisplayPath: trackedRelativePath(root, { path: move.destination }),
  };
}

/** Fold an applied Undo/Reapply into the exact tracker. A file the tracker
 *  cannot read back exactly drops the tracked review rather than leaving it
 *  describing the old disk. */
async function foldReviewMutation({ tracker, moves, unreadable }) {
  try {
    if (unreadable) throw new Error('unreadable');
    const changes = [];
    for (const move of moves) changes.push(await movedFileChange(tracker.worktreeRoot, move));
    foldTrackedChanges(tracker, changes, null);
    if (!(await settledUnifiedDiff(tracker))) releaseDiffTrackerContent(tracker);
  } catch {
    tracker.valid = false;
    releaseDiffTrackerContent(tracker);
    refreshUnifiedDiff(tracker);
  }
}

/** Bring the latest-turn review (composer bar, session Diff) in line with
 *  the disk an Undo/Reapply just changed: signal the moved paths, fold the
 *  mutation into the exact tracker, re-capture the Git snapshot (sealed ones
 *  too) and persist its attribution. Best-effort: the mutation itself
 *  already landed. */
async function refreshLatestTurnReview(ownerSessionId, root, targets, fold) {
  noteTurnWorktreeChange(
    targets
      .flatMap((entry) => [entry.path, entry.oldPath])
      .filter(Boolean)
      .map((path) => resolve(root, path))
  );
  if (fold?.tracker.valid) await foldReviewMutation(fold);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (!tracker?.worktreeSnapshot) return;
  try {
    await refreshTurnWorktreeSnapshot(tracker.worktreeSnapshot, { force: true });
  } catch {
    // Best-effort refresh: persist the last captured state.
  }
  if (tracker.sealed) await persistTurnSnapshotRecord(ownerSessionId, tracker);
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
    const blocked = targets.find((entry) => entry.revertable !== true);
    if (blocked) {
      throw new Error(`${blocked.path} cannot be ${verb}: ${blocked.reason || 'no replayable patch was recorded'}`);
    }
    const fold = await trackedReviewFold(ownerSessionId, record.root, targets, reverse);
    const root = await applyTurnChangeFiles(record, targets, { reverse });
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
        await refreshLatestTurnReview(ownerSessionId, root, targets, fold);
        throw new Error(
          `turn changes were ${verb} but could not be recorded (${error.message}), and restoring the worktree failed (${rollbackError.message}); Undo/Reapply of those files is disabled`,
          { cause: error }
        );
      }
      throw error;
    }
    await refreshLatestTurnReview(ownerSessionId, root, targets, fold);
    return turnChangesReply({
      status: updated ? 'ready' : 'missing',
      checkpointId,
      record: withUnknownChangeStates(ownerSessionId, updated),
    });
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
    // deletion: a worker finishing meanwhile finds no turn to fold into, and
    // a re-seal it (or anything earlier) already queued finds its tracker
    // discarded, so nothing begun before the delete can write it back.
    for (const [trackedSessionId, tracker] of _diffTrackersBySession) {
      if (trackedSessionId !== ownerSessionId && tracker.ownerSessionId !== ownerSessionId) continue;
      tracker.discarded = true;
      tracker.resealQueued = false;
      releaseDiffTrackerContent(tracker);
      _diffTrackersBySession.delete(trackedSessionId);
    }
    _turnsBySession.delete(ownerSessionId);
    for (const key of _unknownChangeStates.keys()) {
      if (key.startsWith(`${ownerSessionId}\0`)) _unknownChangeStates.delete(key);
    }
    // The session's first-seen baselines go too: later edits start fresh ones.
    const [turns] = await Promise.all([
      clearStoredChangeHistory(ownerSessionId),
      clearSessionBaselines(ownerSessionId),
    ]);
    return { turns };
  });
}

export function _resetTurnSnapshotForTest() {
  _turnsBySession.clear();
  _diffTrackersBySession.clear();
  _pendingFreezes.clear();
  _changeMutations.clear();
  _unknownChangeStates.clear();
  _turnOpenedHookForTest = null;
  _agentTurnSeq = 0;
  _resetTurnWorktreeSnapshotsForTest();
  _resetSessionBaselinesForTest();
}

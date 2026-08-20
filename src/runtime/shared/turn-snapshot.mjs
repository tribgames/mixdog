import { createTwoFilesPatch } from 'diff';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  _resetTurnWorktreeSnapshotsForTest,
  createTurnWorktreeSnapshot,
  refreshTurnWorktreeSnapshot,
  revertTurnWorktreeFile,
  revertTurnWorktreeSnapshot,
} from './turn-worktree-snapshot.mjs';

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
const MAX_TRACKED_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_AGENT_REVIEWS_PER_TURN = 32;
const MAX_AGENT_REVIEW_BYTES_PER_TURN = 4 * 1024 * 1024;

const _turnsBySession = new Map();
const _diffTrackersBySession = new Map();
let _agentTurnSeq = 0;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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
  let merged = '';
  for (const value of Array.isArray(values) ? values : [values]) {
    const patch = typeof value === 'string' ? value.trim() : '';
    if (!patch) continue;
    const next = merged ? `${merged}\n${patch}` : patch;
    if (next.length > MAX_PATCH_BYTES) break;
    merged = next;
  }
  return merged;
}

function pathKey(value) {
  const text = clean(value);
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function displayPath(value) {
  return clean(value).replace(/\\/g, '/').replace(/^[ab]\//, '') || 'unknown file';
}

function contentBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), 'utf8');
}

function sameContent(left, right) {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.equals(right);
}

function createDiffTracker(meta = {}) {
  return {
    ownerSessionId: clean(meta.ownerSessionId) || null,
    ownerGeneration: Number(meta.ownerGeneration) || 0,
    worktreeRequest: clean(meta.worktreeRequest),
    worktreeContended: false,
    valid: true,
    sealed: false,
    revision: 0,
    baselineByPath: new Map(),
    currentByPath: new Map(),
    originByCurrentPath: new Map(),
    unifiedDiff: '',
    worktreeSnapshot: null,
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

function renderTrackedPair(before, after) {
  const oldDisplay = before?.displayPath || after?.displayPath || 'unknown file';
  const newDisplay = after?.displayPath || before?.displayPath || 'unknown file';
  const oldGit = `a/${oldDisplay}`;
  const newGit = `b/${newDisplay}`;
  const oldHeader = before?.content === null ? '/dev/null' : oldGit;
  const newHeader = after?.content === null ? '/dev/null' : newGit;
  let head = `diff --git ${oldGit} ${newGit}\n`;
  if (before?.content === null && after?.content !== null) head += 'new file mode 100644\n';
  else if (before?.content !== null && after?.content === null) head += 'deleted file mode 100644\n';
  const oldText = decodeTrackedContent(before?.content ?? null);
  const newText = decodeTrackedContent(after?.content ?? null);
  if (oldText === null || newText === null) {
    return `${head}Binary files ${oldHeader} and ${newHeader} differ\n`;
  }
  try {
    const generated = createTwoFilesPatch(
      oldHeader,
      newHeader,
      oldText,
      newText,
      '',
      '',
      { context: 3, timeout: 100 },
    );
    const headerStart = generated.search(/^--- /m);
    if (headerStart >= 0) return `${head}${generated.slice(headerStart).replace(/\n*$/, '\n')}`;
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

function refreshUnifiedDiff(tracker) {
  if (!tracker.valid) {
    tracker.unifiedDiff = '';
    return;
  }
  const renamePairs = new Map();
  const pairedDestinations = new Set();
  for (const [destinationKey, originKey] of tracker.originByCurrentPath) {
    if (
      destinationKey === originKey
      || tracker.currentByPath.has(originKey)
      || !tracker.currentByPath.has(destinationKey)
      || !tracker.baselineByPath.has(originKey)
      || tracker.baselineByPath.has(destinationKey)
    ) {
      continue;
    }
    renamePairs.set(originKey, destinationKey);
    pairedDestinations.add(destinationKey);
  }
  const handled = new Set();
  const allKeys = [...new Set([
    ...tracker.baselineByPath.keys(),
    ...tracker.currentByPath.keys(),
  ])].sort((left, right) => {
    const leftEntry = tracker.currentByPath.get(left) || tracker.baselineByPath.get(left);
    const rightEntry = tracker.currentByPath.get(right) || tracker.baselineByPath.get(right);
    return String(leftEntry?.displayPath || left).localeCompare(String(rightEntry?.displayPath || right));
  });
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
  let unifiedDiff = '';
  for (const [before, after] of pairs) {
    const beforeContent = before?.content ?? null;
    const afterContent = after?.content ?? null;
    const samePath = before?.displayPath === after?.displayPath;
    if (samePath && sameContent(beforeContent, afterContent)) continue;
    const rendered = renderTrackedPair(
      before || { displayPath: after?.displayPath, content: null },
      after || { displayPath: before?.displayPath, content: null },
    );
    if (unifiedDiff.length + rendered.length > MAX_PATCH_BYTES) break;
    unifiedDiff += rendered;
  }
  tracker.unifiedDiff = unifiedDiff;
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
  const beforePath = safeTrackedTarget(worktree, pair.before?.path || pair.before?.displayPath
    || pair.after?.path || pair.after?.displayPath);
  const afterPath = safeTrackedTarget(worktree, pair.after?.path || pair.after?.displayPath
    || pair.before?.path || pair.before?.displayPath);
  const expectedAfter = pair.after?.content ?? null;
  const actualAfter = await currentTrackedContent(afterPath);
  if (!sameContent(actualAfter, expectedAfter)) {
    throw new Error('turn review revert refused because the file changed after this session edit');
  }
  if (beforePath !== afterPath && await currentTrackedContent(beforePath) !== null) {
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
  if (!tracker.unifiedDiff) releaseDiffTrackerContent(tracker);
}

/**
 * Fold exact committed before/after file states into a session's current turn.
 * A change is `{ path, displayPath, before, after }`; a rename additionally
 * carries `{ newPath, newDisplayPath }`.
 */
export function recordTurnDiffChanges(sessionId, changes = []) {
  if (DISABLED) return '';
  const id = clean(sessionId);
  if (!id) return '';
  const tracker = _diffTrackersBySession.get(id) || resetDiffTracker(id);
  if (!tracker || !tracker.valid || tracker.sealed) return tracker?.unifiedDiff || '';
  for (const raw of Array.isArray(changes) ? changes : []) {
    const sourcePath = clean(raw?.path);
    if (!sourcePath) continue;
    const sourceKey = pathKey(sourcePath);
    const sourceDisplay = displayPath(raw?.displayPath || sourcePath);
    const before = contentBuffer(raw?.before);
    const after = contentBuffer(raw?.after);
    const destinationPath = clean(raw?.newPath);
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
      if (!tracker.currentByPath.has(sourceKey) && !tracker.baselineByPath.has(sourceKey)) {
        tracker.baselineByPath.set(sourceKey, {
          path: sourcePath,
          displayPath: sourceDisplay,
          content: before,
        });
      }
      tracker.currentByPath.set(sourceKey, {
        path: sourcePath,
        displayPath: sourceDisplay,
        content: after,
      });
      continue;
    }

    const destinationKey = pathKey(destinationPath);
    const destinationDisplay = displayPath(raw?.newDisplayPath || destinationPath);
    if (!tracker.currentByPath.has(sourceKey) && !tracker.baselineByPath.has(sourceKey)) {
      tracker.baselineByPath.set(sourceKey, {
        path: sourcePath,
        displayPath: sourceDisplay,
        content: before,
      });
    }
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
  return tracker.unifiedDiff;
}

function trimAgentReviews(turn) {
  const retainedBytes = () => [...turn.agents.values()]
    .reduce((total, review) => total + Buffer.byteLength(review.patch || '', 'utf8'), 0);
  while (
    turn.agents.size > MAX_AGENT_REVIEWS_PER_TURN
    || retainedBytes() > MAX_AGENT_REVIEW_BYTES_PER_TURN
  ) {
    const oldest = turn.agents.keys().next().value;
    if (oldest === undefined) break;
    turn.agents.delete(oldest);
  }
}

function publicAgentReviews(sessionId) {
  const turn = _turnsBySession.get(clean(sessionId));
  if (!turn) return [];
  return [...turn.agents.values()].map((review) => ({ ...review }));
}

/** Start a new user turn and invalidate the prior turn's child review group. */
export async function beginTurnSnapshot(_worktree, sessionId) {
  const ownerSessionId = clean(sessionId);
  if (DISABLED || !ownerSessionId) return;
  const generation = (_turnsBySession.get(ownerSessionId)?.generation || 0) + 1;
  for (const [trackedSessionId, tracker] of _diffTrackersBySession) {
    if (tracker.ownerSessionId === ownerSessionId) _diffTrackersBySession.delete(trackedSessionId);
  }
  _turnsBySession.delete(ownerSessionId);
  _turnsBySession.set(ownerSessionId, {
    generation,
    agents: new Map(),
  });
  const worktreeRequest = pathKey(_worktree);
  const tracker = resetDiffTracker(ownerSessionId, { worktreeRequest });
  trimTurnCache();
  if (!tracker) return;
  for (const [otherSessionId, other] of _diffTrackersBySession) {
    if (otherSessionId === ownerSessionId || other.sealed) continue;
    if (!worktreeRequest || other.worktreeRequest !== worktreeRequest) continue;
    tracker.worktreeContended = true;
    other.worktreeContended = true;
  }
  try {
    const snapshot = await createTurnWorktreeSnapshot(_worktree);
    if (_diffTrackersBySession.get(ownerSessionId) === tracker) {
      tracker.worktreeSnapshot = snapshot;
      if (snapshot?.root) {
        for (const [otherSessionId, other] of _diffTrackersBySession) {
          if (otherSessionId === ownerSessionId) continue;
          // A SEALED turn is finished: its baseline already described the
          // worktree exactly, and completion released its exact-mutation
          // buffers. Marking it contended from here retroactively stripped a
          // completed review of EVERY revert source, so contention is decided
          // between live turns only.
          if (other.sealed) continue;
          if (other.worktreeSnapshot?.root !== snapshot.root) continue;
          // A whole-worktree baseline cannot attribute concurrent mutations
          // to either session. Mark both turns permanently contended and fall
          // back to their exact session-owned mutation trackers.
          tracker.worktreeContended = true;
          other.worktreeContended = true;
        }
      }
    }
  } catch {
    // Git is optional. Exact apply_patch tracking remains the fallback.
  }
}

/** Bind one worker execution to the Lead turn that launched it. */
export function beginAgentTurnReview(ownerSessionId, childSessionId, meta = {}) {
  if (DISABLED) return null;
  const owner = clean(ownerSessionId);
  const child = clean(childSessionId);
  const turn = _turnsBySession.get(owner);
  if (!owner || !child || !turn) return null;
  const existingTracker = _diffTrackersBySession.get(child);
  if (
    !existingTracker
    || existingTracker.ownerSessionId !== owner
    || existingTracker.ownerGeneration !== turn.generation
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

/** Freeze successful worker apply_patch diffs into their owning Lead turn. */
export function completeAgentTurnReview(handle, patches = []) {
  if (!handle || handle.completed === true) return false;
  handle.completed = true;
  const turn = _turnsBySession.get(clean(handle.ownerSessionId));
  const key = clean(handle.sessionId) || handle.id;
  const tracker = _diffTrackersBySession.get(key);
  const matchingTracker = tracker && tracker.ownerSessionId === clean(handle.ownerSessionId)
    && tracker.ownerGeneration === handle.generation;
  try {
    if (!turn || turn.generation !== handle.generation) return false;
    const prior = turn.agents.get(key);
    const tracked = matchingTracker && tracker.revision > 0;
    const patch = tracked ? tracker.unifiedDiff : mergePatches(patches);
    if (!patch) {
      if (tracked && prior) {
        turn.agents.delete(key);
        return true;
      }
      return false;
    }
    turn.agents.delete(key);
    turn.agents.set(key, {
      sessionId: key,
      agent: handle.agent || prior?.agent || null,
      tag: handle.tag || prior?.tag || null,
      patch: tracked ? patch : mergePatches([prior?.patch, patch]),
    });
    trimAgentReviews(turn);
    return true;
  } finally {
    if (matchingTracker && _diffTrackersBySession.get(key) === tracker) {
      releaseDiffTrackerContent(tracker);
      _diffTrackersBySession.delete(key);
    }
  }
}

/** Freeze a completed Lead turn while retaining only its bounded review data. */
export async function completeTurnSnapshot(sessionId) {
  const tracker = _diffTrackersBySession.get(clean(sessionId));
  if (!tracker) return false;
  if (worktreeSnapshotUsable(tracker)) {
    try { await refreshTurnWorktreeSnapshot(tracker.worktreeSnapshot); } catch {}
  }
  tracker.sealed = true;
  // Only a usable Git baseline can replace the exact apply_patch buffers. A
  // contended worktree — and a worktree with no Git baseline at all — retains
  // this session's bounded before/after content so Review can still undo its
  // own files after the turn completes.
  if (worktreeSnapshotUsable(tracker)) releaseDiffTrackerContent(tracker);
  return true;
}

/** Abandon an aborted Lead turn without waiting for optional Git snapshot IO. */
export function cancelTurnSnapshot(sessionId) {
  const ownerSessionId = clean(sessionId);
  if (!ownerSessionId) return false;
  let removed = false;
  for (const [trackedSessionId, tracker] of _diffTrackersBySession) {
    if (trackedSessionId !== ownerSessionId && tracker.ownerSessionId !== ownerSessionId) continue;
    releaseDiffTrackerContent(tracker);
    _diffTrackersBySession.delete(trackedSessionId);
    removed = true;
  }
  if (_turnsBySession.delete(ownerSessionId)) removed = true;
  return removed;
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

/** Return the authoritative Lead net diff plus attributed child reviews. */
export async function getTurnReviewDiff(_worktree, sessionId, options = {}) {
  if (DISABLED) return { supported: false, files: [], patch: '', agents: [] };
  const ownerSessionId = clean(sessionId);
  const turn = _turnsBySession.get(ownerSessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  const isolatedWorktreeSnapshot = worktreeSnapshotUsable(tracker)
    ? tracker.worktreeSnapshot
    : null;
  if (isolatedWorktreeSnapshot && !tracker.sealed && options.refresh !== false) {
    try { await refreshTurnWorktreeSnapshot(isolatedWorktreeSnapshot); } catch {}
  }
  const snapshot = isolatedWorktreeSnapshot;
  // Without a usable baseline the review falls back to this session's own
  // mutations — including a worktree that has no Git repository at all, which
  // used to leave the bar with no revert mode whatsoever.
  const trackedRevertAvailable = !snapshot
    && tracker?.valid === true
    && trackedPairs(tracker).length > 0;
  return {
    supported: true,
    files: snapshot?.files || [],
    patch: snapshot?.patch ?? tracker?.unifiedDiff ?? '',
    snapshotKind: snapshot ? 'worktree' : 'tool',
    revertMode: snapshot ? 'worktree' : trackedRevertAvailable ? 'tracked' : '',
    patchTruncated: snapshot?.patchTruncated === true,
    authoritative: Boolean(turn && tracker),
    agents: publicAgentReviews(ownerSessionId),
    ...(turn ? { generation: turn.generation } : { reason: 'no-turn' }),
  };
}

/** Why this turn cannot revert through its exact apply_patch buffers. */
function unavailableTrackedRevertReason(tracker) {
  return tracker.worktreeContended
    ? 'turn review revert is unavailable while sessions share a worktree'
    : 'turn review tracked file snapshot is unavailable';
}

/** Restore one reviewed file to this turn's worktree baseline, never to HEAD. */
export async function revertTurnReviewFile(_worktree, sessionId, file) {
  const ownerSessionId = clean(sessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (tracker && !worktreeSnapshotUsable(tracker)) {
    const pairs = trackedPairs(tracker);
    if (pairs.length === 0) throw new Error(unavailableTrackedRevertReason(tracker));
    const pair = pairs.find((entry) => pairMatchesFile(entry, _worktree, file));
    if (!pair) throw new Error('turn review tracked file snapshot is unavailable');
    await revertTrackedPairs(tracker, _worktree, [pair]);
    return await getTurnReviewDiff(_worktree, ownerSessionId);
  }
  if (!tracker?.worktreeSnapshot) throw new Error('turn worktree snapshot is unavailable');
  await revertTurnWorktreeFile(tracker.worktreeSnapshot, file);
  return await getTurnReviewDiff(_worktree, ownerSessionId);
}

/** Restore every file in the reviewed turn to its turn-start state. */
export async function revertTurnReview(_worktree, sessionId) {
  const ownerSessionId = clean(sessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  if (tracker && !worktreeSnapshotUsable(tracker)) {
    const pairs = trackedPairs(tracker);
    if (pairs.length === 0) throw new Error(unavailableTrackedRevertReason(tracker));
    await revertTrackedPairs(tracker, _worktree, pairs);
    return await getTurnReviewDiff(_worktree, ownerSessionId);
  }
  if (!tracker?.worktreeSnapshot) throw new Error('turn worktree snapshot is unavailable');
  await revertTurnWorktreeSnapshot(tracker.worktreeSnapshot);
  return await getTurnReviewDiff(_worktree, ownerSessionId);
}

export function _resetTurnSnapshotForTest() {
  _turnsBySession.clear();
  _diffTrackersBySession.clear();
  _agentTurnSeq = 0;
  _resetTurnWorktreeSnapshotsForTest();
}

export function _turnSnapshotStatsForTest(sessionId) {
  const tracker = _diffTrackersBySession.get(clean(sessionId));
  if (!tracker) return null;
  return {
    valid: tracker.valid,
    sealed: tracker.sealed,
    trackedBytes: trackedContentBytes(tracker),
    trackedPaths: tracker.baselineByPath.size + tracker.currentByPath.size,
    patchBytes: Buffer.byteLength(tracker.unifiedDiff || '', 'utf8'),
    snapshotKind: tracker.worktreeSnapshot ? 'worktree' : 'tool',
    snapshotFiles: tracker.worktreeSnapshot?.files?.length || 0,
  };
}

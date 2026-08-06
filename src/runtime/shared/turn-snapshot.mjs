import { createTwoFilesPatch } from 'diff';

// Turn-scoped review registry.
//
// Codex keeps the first committed content and the latest committed content for
// every path, then re-renders ONE net unified diff after each apply_patch. This
// module owns the same contract for Desktop/TUI: proposed, rejected, dry-run,
// and rolled-back hunks never enter the review; repeated edits collapse to the
// first-before/latest-after state; a full revert removes the file again.
//
// Worker trackers remain separate and are frozen into the owning Lead turn on
// completion, preserving attribution without assigning worker edits to Lead.
// Shell/background/external-editor writes are intentionally excluded.

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
    valid: true,
    sealed: false,
    revision: 0,
    baselineByPath: new Map(),
    currentByPath: new Map(),
    originByCurrentPath: new Map(),
    unifiedDiff: '',
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
  resetDiffTracker(ownerSessionId);
  trimTurnCache();
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

/** Freeze a completed Lead turn while retaining only its bounded unified diff. */
export function completeTurnSnapshot(sessionId) {
  const tracker = _diffTrackersBySession.get(clean(sessionId));
  if (!tracker) return false;
  tracker.sealed = true;
  releaseDiffTrackerContent(tracker);
  return true;
}

/** Return the authoritative Lead net diff plus attributed child reviews. */
export async function getTurnReviewDiff(_worktree, sessionId) {
  if (DISABLED) return { supported: false, files: [], patch: '', agents: [] };
  const ownerSessionId = clean(sessionId);
  const turn = _turnsBySession.get(ownerSessionId);
  const tracker = _diffTrackersBySession.get(ownerSessionId);
  return {
    supported: true,
    files: [],
    patch: tracker?.unifiedDiff || '',
    authoritative: Boolean(turn && tracker),
    agents: publicAgentReviews(ownerSessionId),
    ...(turn ? { generation: turn.generation } : { reason: 'no-turn' }),
  };
}

export function _resetTurnSnapshotForTest() {
  _turnsBySession.clear();
  _diffTrackersBySession.clear();
  _agentTurnSeq = 0;
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
  };
}

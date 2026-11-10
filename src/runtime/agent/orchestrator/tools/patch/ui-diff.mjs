// UI-diff side channel: a committed apply_patch (or edit-tool write) records
// a turn-review change entry and a per-call diff the desktop/TUI tool cards
// pick up. Display only — never affects edit semantics.
import { createLineDiffBudget, lineDiffHunks, unifiedHunksBody } from '../../../../shared/bounded-line-diff.mjs';
import { boundReviewPatch } from '../../../../shared/review-diff.mjs';
import { decodeText } from '../../../../shared/turn-changes.mjs';
import { recordTurnDiffChanges } from '../../../../shared/turn-snapshot.mjs';
import { pathKey, resolveV4AEntryPath } from './paths.mjs';
import { patchHeaderPathForResolved } from './read-redirects.mjs';
import { capturePatchRollbackState } from './rollback-state.mjs';

const APPLY_PATCH_UI_DIFF_MAX_CHARS = 64 * 1024;
const APPLY_PATCH_UI_DIFF_REGISTRY_MAX = 64;
const _applyPatchUiDiffByCallId = new Map();

function registerApplyPatchUiDiff(callId, diff) {
  if (!callId || typeof diff !== 'string') return;
  const { patch: text } = boundReviewPatch(diff, APPLY_PATCH_UI_DIFF_MAX_CHARS);
  if (_applyPatchUiDiffByCallId.size >= APPLY_PATCH_UI_DIFF_REGISTRY_MAX) {
    const oldest = _applyPatchUiDiffByCallId.keys().next().value;
    if (oldest !== undefined) _applyPatchUiDiffByCallId.delete(oldest);
  }
  _applyPatchUiDiffByCallId.set(callId, text);
}

export function takeApplyPatchUiDiff(callId) {
  if (!callId) return null;
  if (!_applyPatchUiDiffByCallId.has(callId)) return null;
  const value = _applyPatchUiDiffByCallId.get(callId);
  _applyPatchUiDiffByCallId.delete(callId);
  return value;
}

// A display path is a plain relative or absolute path; the patch header only
// needs forward slashes. Its own leading "a/" is part of the name.
function headerPath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/');
}

function isOmitted(value) {
  return Boolean(value) && typeof value === 'object' && !(value instanceof Uint8Array) && value.omitted === true;
}

// Text of one side: '' for an absent file, null when it is binary (not UTF-8
// or holding a NUL byte) — the same rule as the turn review's tracker diffs.
function sideText(value) {
  if (value == null || typeof value === 'string' || value instanceof Uint8Array) return decodeText(value);
  return null;
}

// One file's change, from the call's own before and after states: absent
// (null), bytes or text, or an omitted marker when the bytes were not kept.
// `budget` is the call's line-diff budget.
function renderCallChange({ displayPath, newDisplayPath, before, after }, budget) {
  const oldName = headerPath(displayPath) || 'unknown file';
  const newName = headerPath(newDisplayPath) || oldName;
  const oldHeader = before == null ? '/dev/null' : `a/${oldName}`;
  const newHeader = after == null ? '/dev/null' : `b/${newName}`;
  let head = `diff --git a/${oldName} b/${newName}\n`;
  if (before == null && after != null) head += 'new file mode 100644\n';
  else if (before != null && after == null) head += 'deleted file mode 100644\n';
  if (isOmitted(before) || isOmitted(after)) {
    return `${head}Binary files ${oldHeader} and ${newHeader} differ\n`;
  }
  const oldText = sideText(before);
  const newText = sideText(after);
  if (oldText === null || newText === null) return `${head}Binary files ${oldHeader} and ${newHeader} differ\n`;
  if (oldText === newText) {
    // An empty file created or deleted still changed: git writes the mode line alone.
    if ((before == null) !== (after == null)) return head;
    return oldName === newName ? '' : `${head}similarity index 100%\nrename from ${oldName}\nrename to ${newName}\n`;
  }
  const rename = oldName === newName ? '' : `rename from ${oldName}\nrename to ${newName}\n`;
  const { hunks } = lineDiffHunks(oldText, newText, budget, [before ?? null, after ?? null]);
  return `${head}${rename}${unifiedHunksBody(oldHeader, newHeader, hunks)}`;
}

// Added/deleted lines of one rendered change, counted in its hunks only.
function hunkLineCounts(patch) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) additions += 1;
    else if (inHunk && line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

// Each change with the line counts of its own unbounded diff (the turn review
// sums them per file), plus the call's whole diff, within the call's budget.
export function measureCallChanges(changes, budget = createLineDiffBudget()) {
  const patches = (changes || []).map((change) => renderCallChange(change, budget));
  return {
    diff: patches.join(''),
    changes: (changes || []).map((change, index) => ({ ...change, ...hunkLineCounts(patches[index]) })),
  };
}

// A call's card shows the change that call made — its own before against its
// own after — never the turn's running total for the same files.
export function callUiDiff(changes) {
  return measureCallChanges(changes).diff;
}

// Fold the call's measured changes into the turn review and publish its card
// diff. Both share one line-diff budget: the call is one operation.
function recordCallChanges(callId, sessionId, changes) {
  const budget = createLineDiffBudget();
  const measured = measureCallChanges(changes, budget);
  recordTurnDiffChanges(sessionId, measured.changes, budget);
  registerApplyPatchUiDiff(callId, measured.diff);
}

// Edit-tool UI diff: a successful single-file str-replace edit records the
// same turn-review change entry and per-call UI diff side channel that a
// committed apply_patch gets, so desktop/TUI tool cards render both edit
// dialects identically. Side channel only — never affects edit semantics.
export function registerEditToolUiDiff({ callId, sessionId, basePath, fullPath, before, after }) {
  if (!callId || !sessionId || typeof fullPath !== 'string') return;
  try {
    recordCallChanges(callId, sessionId, [toolFileChange(basePath, { fullPath, before, after })]);
  } catch {
    // best-effort display channel
  }
}

function toolFileChange(basePath, { fullPath, before, after }) {
  return {
    path: fullPath,
    displayPath: patchHeaderPathForResolved(basePath || '', fullPath),
    before: before ?? null,
    after: after ?? null,
  };
}

// Writes of a tool without a per-call card (tidy, office): each change
// `{ fullPath, before, after }` (null = absent, bytes, or an omitted marker)
// joins the turn review with its own line counts, like an edit-tool write.
// Side channel only — never affects the tool result.
export function recordToolFileChanges({ sessionId, basePath, changes }) {
  if (!sessionId || !changes?.length) return;
  try {
    const budget = createLineDiffBudget();
    recordTurnDiffChanges(
      sessionId,
      measureCallChanges(
        changes.map((change) => toolFileChange(basePath, change)),
        budget
      ).changes,
      budget
    );
  } catch {
    // best-effort review channel
  }
}

// Review content of one snapshot: null when absent, the bytes when captured,
// and an explicit omitted marker (never empty bytes) when they were not.
function snapshotContent(snapshot) {
  if (!snapshot?.existed) return null;
  if (snapshot.omitted) return { omitted: true, size: snapshot.size, reason: snapshot.omittedReason };
  return snapshot.content;
}

function snapshotByPath(snapshots) {
  return new Map((snapshots || []).map((snapshot) => [pathKey(snapshot.fullPath), snapshot]));
}

// `paths` are the targets the apply ACTUALLY mutated (written, deleted or
// moved), as reported by the apply path itself — never every attempted target:
// a refused or never-applied target is not a change. Whether a path changed is
// never inferred from file metadata.
export function registerCommittedPatchUiDiff({
  callId,
  sessionId,
  basePath,
  beforeSnapshots,
  paths,
  renameSections = [],
}) {
  if (!callId || !sessionId || !Array.isArray(beforeSnapshots) || beforeSnapshots.length === 0) return;
  try {
    const afterSnapshots = capturePatchRollbackState(paths);
    const beforeByPath = snapshotByPath(beforeSnapshots);
    const afterByPath = snapshotByPath(afterSnapshots);
    const renamedPaths = new Set();
    const changes = [];
    for (const section of renameSections || []) {
      const sourcePath = resolveV4AEntryPath(basePath, section.path);
      const destinationPath = resolveV4AEntryPath(basePath, section.movePath);
      const sourceKey = pathKey(sourcePath);
      const destinationKey = pathKey(destinationPath);
      const before = beforeByPath.get(sourceKey);
      const after = afterByPath.get(destinationKey);
      changes.push({
        path: sourcePath,
        displayPath: patchHeaderPathForResolved(basePath, sourcePath),
        newPath: destinationPath,
        newDisplayPath: patchHeaderPathForResolved(basePath, destinationPath),
        before: snapshotContent(before),
        after: snapshotContent(after),
      });
      renamedPaths.add(sourceKey);
      renamedPaths.add(destinationKey);
    }
    for (const fullPath of paths || []) {
      const key = pathKey(fullPath);
      if (renamedPaths.has(key)) continue;
      const before = beforeByPath.get(key);
      const after = afterByPath.get(key);
      changes.push({
        path: fullPath,
        displayPath: patchHeaderPathForResolved(basePath, fullPath),
        before: snapshotContent(before),
        after: snapshotContent(after),
      });
    }
    recordCallChanges(callId, sessionId, changes);
  } catch {
    // Review collection is a side channel and must never affect committed
    // apply_patch success/failure semantics.
  }
}

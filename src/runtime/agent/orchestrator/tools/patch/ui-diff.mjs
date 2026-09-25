// UI-diff side channel: a committed apply_patch (or edit-tool write) records
// a turn-review change entry and a per-call diff the desktop/TUI tool cards
// pick up. Display only — never affects edit semantics.
import { boundReviewPatch } from '../../../../shared/review-diff.mjs';
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

// Edit-tool UI diff: a successful single-file str-replace edit records the
// same turn-review change entry and per-call UI diff side channel that a
// committed apply_patch gets, so desktop/TUI tool cards render both edit
// dialects identically. Side channel only — never affects edit semantics.
export function registerEditToolUiDiff({ callId, sessionId, basePath, fullPath, before, after }) {
  if (!callId || !sessionId || typeof fullPath !== 'string') return;
  try {
    const turnDiff = recordTurnDiffChanges(sessionId, [
      {
        path: fullPath,
        displayPath: patchHeaderPathForResolved(basePath || '', fullPath),
        before: before ?? null,
        after: after ?? null,
      },
    ]);
    registerApplyPatchUiDiff(callId, turnDiff);
  } catch {
    // best-effort display channel
  }
}

function snapshotByPath(snapshots) {
  return new Map((snapshots || []).map((snapshot) => [pathKey(snapshot.fullPath), snapshot]));
}

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
        before: before?.existed ? before.content : null,
        after: after?.existed ? after.content : null,
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
        before: before?.existed ? before.content : null,
        after: after?.existed ? after.content : null,
      });
    }
    const turnDiff = recordTurnDiffChanges(sessionId, changes);
    registerApplyPatchUiDiff(callId, turnDiff);
  } catch {
    // Review collection is a side channel and must never affect committed
    // apply_patch success/failure semantics.
  }
}

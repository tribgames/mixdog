// Codex batch: validate the complete patch before writing (one operation per
// target), then apply it in one shot under path locks with all-or-nothing
// rollback.
import { parsePatch } from 'diff';
import { withBuiltinPathLocks } from '../../builtin.mjs';
import { withAdvisoryLocks } from '../../builtin/advisory-lock.mjs';
import { wrapPatchMutationOutput } from '../mutation-output.mjs';
import { ensureNativePatchBinaryAvailable } from '../native-server.mjs';
import {
  canFallbackCountedUnified,
  hasUnifiedBareV4AHunk,
  isV4APatchInput,
  parseUnifiedBareV4APatch,
  parseUnifiedCountedAsV4APatch,
  parseV4APatch,
  prepareInput,
} from '../parsing.mjs';
import { preValidateNativeBatch, resolveV4AEntryPath, splitParsedModifyWaves } from '../paths.mjs';
import { rewriteParsedReadRedirects, rewriteV4AReadRedirects } from '../read-redirects.mjs';
import { setPatchReplayPreSnapshots } from '../replay-capture.mjs';
import { capturePatchRollbackState, restorePatchRollbackState } from '../rollback-state.mjs';
import { coalesceCompatibleV4ASections } from '../section-coalesce.mjs';
import { registerCommittedPatchUiDiff } from '../ui-diff.mjs';
import {
  applyV4ARenameSections,
  convertV4ASectionsToUnifiedPatch,
  formatV4ARenameSuccessLines,
  planV4ARenameSections,
} from '../v4a-convert.mjs';
import { applyParsedWave, isPatchErrorText } from '../wave.mjs';

// Convert the body to a unified patch (V4A / bare-@@ / counted-unified
// fallback), split it into unique-target waves and pre-validate each. Returns
// { error } for the outcomes the tool reports as text; parse failures throw.
export async function prepareCodexBatch({
  patchStr,
  requestedFormat,
  basePath,
  readStateScope,
  preParsedV4ASections,
  v4aConvertOpts,
  mutationPlan,
}) {
  let inputPatchStr = patchStr;
  let v4aRenamePlan = null;
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      const parsedSections =
        preParsedV4ASections || rewriteV4AReadRedirects(parseV4APatch(patchStr), basePath, readStateScope);
      const allSections = coalesceCompatibleV4ASections(parsedSections, basePath);
      v4aRenamePlan = await planV4ARenameSections(allSections, basePath);
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(v4aRenamePlan.remainingSections, basePath, v4aConvertOpts);
      if (v4aRenamePlan.renameSections.length > 0) {
        mutationPlan =
          v4aRenamePlan.remainingSections.length > 0
            ? { sourceTool: 'apply_patch', engine: 'v4a-patch', reason: 'v4a-mixed' }
            : { sourceTool: 'apply_patch', engine: 'v4a-rename', reason: 'v4a-move' };
      }
    } catch (err) {
      throw new Error(`apply_patch: V4A parse failed — ${err?.message || String(err)}`);
    }
  } else if (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr)) {
    try {
      const sections = rewriteV4AReadRedirects(parseUnifiedBareV4APatch(patchStr), basePath, readStateScope);
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(sections, basePath, v4aConvertOpts);
    } catch (err) {
      throw new Error(`apply_patch: bare @@ parse failed — ${err?.message || String(err)}`);
    }
  }
  let normalizedPatchStr = prepareInput(inputPatchStr);
  const v4aRenameOnly = v4aRenamePlan?.renameSections?.length > 0 && v4aRenamePlan.remainingSections.length === 0;

  let parsed = [];
  if (!v4aRenameOnly)
    try {
      parsed = parsePatch(normalizedPatchStr);
    } catch (err) {
      if (!canFallbackCountedUnified(patchStr, requestedFormat, err)) {
        throw new Error(
          `apply_patch: parse failed — ${err?.message || String(err)}; prefer V4A envelope for multi-hunk edits (no @@ line counts)`
        );
      }
      try {
        const sections = rewriteV4AReadRedirects(parseUnifiedCountedAsV4APatch(patchStr), basePath, readStateScope);
        inputPatchStr = await convertV4ASectionsToUnifiedPatch(sections, basePath, v4aConvertOpts);
        normalizedPatchStr = prepareInput(inputPatchStr);
        parsed = parsePatch(normalizedPatchStr);
        mutationPlan = {
          sourceTool: 'apply_patch',
          engine: 'v4a-patch',
          reason: 'unified-count-fallback',
        };
      } catch (fallbackErr) {
        throw new Error(
          `apply_patch: parse failed — ${err?.message || String(err)}; V4A fallback failed — ${fallbackErr?.message || String(fallbackErr)}`
        );
      }
    }
  if (!v4aRenameOnly) {
    parsed = rewriteParsedReadRedirects(parsed, basePath, readStateScope);
  }
  if (!v4aRenameOnly && (!Array.isArray(parsed) || parsed.length === 0)) {
    return { error: 'Error: patch contained no file sections' };
  }
  // Validate Codex's one-operation-per-target rule and build one batch.
  let parsedWaves = v4aRenameOnly ? [] : [parsed];
  if (!v4aRenameOnly) {
    try {
      parsedWaves = splitParsedModifyWaves(parsed, basePath);
    } catch (err) {
      return { error: `Error: ${err?.message || String(err)}` };
    }
  }

  if (!v4aRenameOnly) {
    try {
      await ensureNativePatchBinaryAvailable();
    } catch (err) {
      return { error: `Error: ${err?.message || String(err)}` };
    }
  }
  // Pre-validate each wave independently: a wave only ever holds unique
  // targets, so the native batch's per-file semantics stay intact.
  const waveDispatch = [];
  if (!v4aRenameOnly) {
    try {
      for (const wparsed of parsedWaves) {
        const { entries, headerRewrites } = await preValidateNativeBatch(wparsed, basePath);
        waveDispatch.push({ parsed: wparsed, entries, headerRewrites });
      }
    } catch (err) {
      return { error: `Error: ${err?.message || String(err)}` };
    }
  }

  const lockPaths = [
    ...new Set(waveDispatch.flatMap((wd) => wd.entries.map((entry) => entry.fullPath))),
    ...(v4aRenamePlan?.renameSections || []).flatMap((section) => {
      const src = resolveV4AEntryPath(basePath, section.path);
      const dest = resolveV4AEntryPath(basePath, section.movePath);
      return [src, dest];
    }),
  ];
  return { waveDispatch, v4aRenamePlan, v4aRenameOnly, mutationPlan, lockPaths };
}

// Apply the validated batch in one shot: renames first, then the single wave
// via applyParsedWave (native + JS split). Returns the model-surface text.
export async function runCodexBatch({ batch, basePath, v4aConvertOpts, rejectedV4AHunks, waveOpts }) {
  const { waveDispatch, v4aRenamePlan, v4aRenameOnly, mutationPlan } = batch;
  let v4aRenameResults = [];
  if (v4aRenamePlan?.renameSections?.length) {
    v4aRenameResults = await applyV4ARenameSections(v4aRenamePlan.renameSections, basePath, v4aConvertOpts);
  }
  if (v4aRenameOnly) {
    const lines = formatV4ARenameSuccessLines(v4aRenameResults);
    if (lines.length === 0) return 'Error: patch contained no applicable file sections';
    return wrapPatchMutationOutput(`${lines.join('\n')}\n`, mutationPlan, { executor: 'v4a-rename' });
  }
  const res = await applyParsedWave(waveDispatch[0], basePath, waveOpts);
  const executor = res.executor;
  if (res.error) return wrapPatchMutationOutput(res.error, mutationPlan, { executor });
  let combined = res.text;
  const renameLines = formatV4ARenameSuccessLines(v4aRenameResults);
  if (renameLines.length > 0 && !isPatchErrorText(combined)) {
    combined = `${renameLines.join('\n')}\n${combined}`;
  }
  if (!isPatchErrorText(combined) && rejectedV4AHunks.length > 0) {
    const tail = [
      '',
      `hunk-level rejected (rejectPartial=false, V4A): ${rejectedV4AHunks.length}`,
      ...rejectedV4AHunks.map(
        (r) =>
          `  REJECT ${r.file || '(unknown)'} — ${String(r.reason || '')
            .split(';')[0]
            .trim()}`
      ),
    ];
    return wrapPatchMutationOutput(`${combined}\n${tail.join('\n')}`, mutationPlan, { executor });
  }
  return wrapPatchMutationOutput(combined, mutationPlan, { executor });
}

// Codex mode applies the validated batch in one shot. A batch that mixes
// native (in-base) with JS (out-of-base) entries commits the native writes
// before the JS entries run. Snapshot every touched path up front and restore
// it whenever the batch fails — by returned Error text OR by a thrown error
// (V4A rename, persistence) — so mode:"atomic" really is all-or-nothing
// instead of leaving an earlier commit in place.
export function applyCodexBatchWithRollback({ batch, basePath, dryRun, readStateScope, options, runBatch }) {
  const { lockPaths, v4aRenamePlan } = batch;
  const registerUiDiff = (rollbackSnapshots) =>
    registerCommittedPatchUiDiff({
      callId: options?.toolCallId,
      sessionId: options?.sessionId,
      basePath,
      beforeSnapshots: rollbackSnapshots,
      paths: lockPaths,
      renameSections: v4aRenamePlan?.renameSections,
    });
  return withBuiltinPathLocks(lockPaths, () =>
    withAdvisoryLocks(lockPaths, async () => {
      let rollbackSnapshots = [];
      if (!dryRun) {
        try {
          rollbackSnapshots = capturePatchRollbackState(lockPaths);
          setPatchReplayPreSnapshots(options?.replayCapture, rollbackSnapshots);
        } catch (err) {
          return `Error: ${err?.message || String(err)}`;
        }
      }
      // Restoration errors are never swallowed: an incomplete rollback is
      // reported verbatim so the caller never reads a false all-or-nothing.
      const withRollback = (outcome) => {
        const rollbackErrors = restorePatchRollbackState(rollbackSnapshots, readStateScope);
        return {
          text:
            rollbackErrors.length === 0
              ? `${outcome}\n--- rolled back: every touched path was restored to its pre-patch state ---`
              : [outcome, '--- rollback incomplete ---', ...rollbackErrors].join('\n'),
          rollbackErrors,
        };
      };
      let outcome;
      try {
        outcome = await runBatch();
      } catch (err) {
        // A thrown failure (e.g. V4A rename) took the same path to disk as a
        // returned one, so it takes the same path back out.
        if (dryRun) throw err;
        const rolledBack = withRollback(`Error: ${err?.message || String(err)}`);
        if (rolledBack.rollbackErrors.length > 0) registerUiDiff(rollbackSnapshots);
        return rolledBack.text;
      }
      if (dryRun) return outcome;
      if (!isPatchErrorText(outcome)) {
        registerUiDiff(rollbackSnapshots);
        return outcome;
      }
      const rolledBack = withRollback(outcome);
      if (rolledBack.rollbackErrors.length > 0) registerUiDiff(rollbackSnapshots);
      return rolledBack.text;
    })
  );
}

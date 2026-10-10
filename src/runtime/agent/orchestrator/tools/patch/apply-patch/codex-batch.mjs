// Codex batch: validate the complete patch before writing (one operation per
// target), then apply it in one shot under path locks with all-or-nothing
// rollback.
import { parsePatch } from 'diff';
import { throwIfAborted } from '../../../../../shared/abort-race.mjs';
import { normalizeOutputPath, withBuiltinPathLocks } from '../../builtin.mjs';
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
import { contentEditRefusalMessage } from '../content-guard.mjs';
import {
  commitDeleteQuarantine,
  createDeleteQuarantine,
  formatQuarantineLeftovers,
  markQuarantineOmittedSnapshots,
  rollbackDeleteQuarantine,
} from '../delete-quarantine.mjs';
import { pathKey, preValidateNativeBatch, resolveV4AEntryPath, splitParsedModifyWaves } from '../paths.mjs';
import { rewriteParsedReadRedirects, rewriteV4AReadRedirects } from '../read-redirects.mjs';
import { setPatchReplayPreSnapshots } from '../replay-capture.mjs';
import { capturePatchRollbackState, restorePatchRollbackState } from '../rollback-state.mjs';
import { coalesceCompatibleV4ASections } from '../section-coalesce.mjs';
import { rejectedHunkTail } from '../sequence/report.mjs';
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
export async function prepareCodexBatch({ patchStr, requestedFormat, basePath, preParsedV4ASections, v4aConvertOpts }) {
  let inputPatchStr = patchStr;
  let v4aRenamePlan = null;
  if (isV4APatchInput(patchStr, requestedFormat)) {
    try {
      const parsedSections = preParsedV4ASections || rewriteV4AReadRedirects(parseV4APatch(patchStr), basePath);
      const allSections = coalesceCompatibleV4ASections(parsedSections, basePath);
      v4aRenamePlan = await planV4ARenameSections(allSections, basePath);
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(v4aRenamePlan.remainingSections, basePath, v4aConvertOpts);
    } catch (err) {
      throw new Error(`apply_patch: V4A parse failed — ${err?.message || String(err)}`);
    }
  } else if (requestedFormat !== 'unified' && hasUnifiedBareV4AHunk(patchStr)) {
    try {
      const sections = rewriteV4AReadRedirects(parseUnifiedBareV4APatch(patchStr), basePath);
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(sections, basePath, v4aConvertOpts);
    } catch (err) {
      throw new Error(`apply_patch: bare @@ parse failed — ${err?.message || String(err)}`);
    }
  }
  const v4aRenameOnly = v4aRenamePlan?.renameSections?.length > 0 && v4aRenamePlan.remainingSections.length === 0;
  if (v4aRenameOnly) {
    return {
      waveDispatch: [],
      v4aRenamePlan,
      v4aRenameOnly,
      lockPaths: renameLockPaths(v4aRenamePlan, basePath),
    };
  }

  let parsed;
  try {
    parsed = parsePatch(prepareInput(inputPatchStr));
  } catch (err) {
    if (!canFallbackCountedUnified(patchStr, requestedFormat, err)) {
      throw new Error(
        `apply_patch: parse failed — ${err?.message || String(err)}; prefer V4A envelope for multi-hunk edits (no @@ line counts)`
      );
    }
    try {
      const sections = rewriteV4AReadRedirects(parseUnifiedCountedAsV4APatch(patchStr), basePath);
      inputPatchStr = await convertV4ASectionsToUnifiedPatch(sections, basePath, v4aConvertOpts);
      parsed = parsePatch(prepareInput(inputPatchStr));
    } catch (fallbackErr) {
      throw new Error(
        `apply_patch: parse failed — ${err?.message || String(err)}; V4A fallback failed — ${fallbackErr?.message || String(fallbackErr)}`
      );
    }
  }
  parsed = rewriteParsedReadRedirects(parsed, basePath);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: 'Error: patch contained no file sections' };
  }
  // Validate Codex's one-operation-per-target rule and build one batch.
  let parsedWaves;
  try {
    parsedWaves = splitParsedModifyWaves(parsed, basePath);
  } catch (err) {
    return { error: `Error: ${err?.message || String(err)}` };
  }

  try {
    await ensureNativePatchBinaryAvailable();
  } catch (err) {
    return { error: `Error: ${err?.message || String(err)}` };
  }
  // Pre-validate each wave independently: a wave only ever holds unique
  // targets, so the native batch's per-file semantics stay intact.
  const waveDispatch = [];
  try {
    for (const wparsed of parsedWaves) {
      const { entries, headerRewrites } = await preValidateNativeBatch(wparsed, basePath);
      waveDispatch.push({ parsed: wparsed, entries, headerRewrites });
    }
  } catch (err) {
    return { error: `Error: ${err?.message || String(err)}` };
  }

  const lockPaths = [
    ...new Set(waveDispatch.flatMap((wd) => wd.entries.map((entry) => entry.fullPath))),
    ...renameLockPaths(v4aRenamePlan, basePath),
  ];
  return { waveDispatch, v4aRenamePlan, v4aRenameOnly, lockPaths };
}

function renameLockPaths(v4aRenamePlan, basePath) {
  return (v4aRenamePlan?.renameSections || []).flatMap((section) => [
    resolveV4AEntryPath(basePath, section.path),
    resolveV4AEntryPath(basePath, section.movePath),
  ]);
}

// Apply the validated batch in one shot: renames first, then the single wave
// via applyParsedWave (native + JS split). Returns the model-surface text.
export async function runCodexBatch({ batch, basePath, v4aConvertOpts, rejectedV4AHunks, waveOpts }) {
  const { waveDispatch, v4aRenamePlan, v4aRenameOnly } = batch;
  let v4aRenameResults = [];
  if (v4aRenamePlan?.renameSections?.length) {
    v4aRenameResults = await applyV4ARenameSections(v4aRenamePlan.renameSections, basePath, v4aConvertOpts);
  }
  if (v4aRenameOnly) {
    const lines = formatV4ARenameSuccessLines(v4aRenameResults);
    if (lines.length === 0) return 'Error: patch contained no applicable file sections';
    return wrapPatchMutationOutput(`${lines.join('\n')}\n`);
  }
  const res = await applyParsedWave(waveDispatch[0], basePath, waveOpts);
  if (res.error) return wrapPatchMutationOutput(res.error);
  let combined = res.text;
  if (!isPatchErrorText(combined)) {
    const renameLines = formatV4ARenameSuccessLines(v4aRenameResults);
    if (renameLines.length > 0) combined = `${renameLines.join('\n')}\n${combined}`;
    combined += rejectedHunkTail(rejectedV4AHunks);
  }
  return wrapPatchMutationOutput(combined);
}

// Codex mode applies the validated batch in one shot. A batch that mixes
// native (in-base) with JS (out-of-base) entries commits the native writes
// before the JS entries run. Snapshot every touched path up front and restore
// it whenever the batch fails — by returned Error text OR by a thrown error
// (V4A rename, persistence) — so mode:"atomic" really is all-or-nothing
// instead of leaving an earlier commit in place.
//
// A content edit or rename whose source snapshot is omitted (binary, oversized
// or past the snapshot budget) has no rollback source: refuse it before the
// first mutation. Deletes of such files go through the delete quarantine passed
// to runBatch(deleteQuarantine): rolled back by renaming back, committed here.
function unprotectedEditRefusal(batch, snapshots, basePath) {
  const editKeys = new Set([
    ...(batch.waveDispatch || []).flatMap((wave) =>
      wave.entries.filter((entry) => entry.kind === 'modify').map((entry) => pathKey(entry.fullPath))
    ),
    ...(batch.v4aRenamePlan?.renameSections || []).map((section) =>
      pathKey(resolveV4AEntryPath(basePath, section.path))
    ),
  ]);
  const hit = snapshots.find((snapshot) => snapshot.omitted && editKeys.has(pathKey(snapshot.fullPath)));
  return hit
    ? contentEditRefusalMessage(normalizeOutputPath(hit.fullPath), { reason: hit.omittedReason, size: hit.size })
    : null;
}

export function applyCodexBatchWithRollback({
  batch,
  basePath,
  dryRun,
  readStateScope,
  abortSignal,
  options,
  runBatch,
}) {
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
      throwIfAborted(abortSignal);
      let rollbackSnapshots = [];
      const deleteQuarantine = dryRun ? null : createDeleteQuarantine();
      if (!dryRun) {
        try {
          rollbackSnapshots = capturePatchRollbackState(lockPaths);
          setPatchReplayPreSnapshots(options?.replayCapture, rollbackSnapshots);
        } catch (err) {
          return `Error: ${err?.message || String(err)}`;
        }
        const refusal = unprotectedEditRefusal(batch, rollbackSnapshots, basePath);
        if (refusal) return `Error: ${refusal}`;
        markQuarantineOmittedSnapshots(deleteQuarantine, rollbackSnapshots);
      }
      // Restoration errors are never swallowed: an incomplete rollback is
      // reported verbatim so the caller never reads a false all-or-nothing.
      const withRollback = (outcome) => {
        const rollbackErrors = [
          ...rollbackDeleteQuarantine(deleteQuarantine, readStateScope),
          ...restorePatchRollbackState(rollbackSnapshots, readStateScope),
        ];
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
        outcome = await runBatch(deleteQuarantine);
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
        const leftovers = commitDeleteQuarantine(deleteQuarantine);
        registerUiDiff(rollbackSnapshots);
        return leftovers.length > 0 ? `${outcome}\n${formatQuarantineLeftovers(leftovers)}` : outcome;
      }
      const rolledBack = withRollback(outcome);
      if (rolledBack.rollbackErrors.length > 0) registerUiDiff(rollbackSnapshots);
      return rolledBack.text;
    })
  );
}

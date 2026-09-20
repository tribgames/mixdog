// Default ordered section mode. Apply each file section in listed order,
// converting every V4A section against the CURRENT on-disk state (i.e. after
// all earlier sections have committed), and stop at the first section that
// fails. Reports applied / failed / skipped reflecting true disk state. Unit
// construction, execution and the report live under ./sequence/.
import { withBuiltinPathLocks } from '../builtin.mjs';
import { withAdvisoryLocks } from '../builtin/advisory-lock.mjs';
import { wrapPatchMutationOutput } from './mutation-output.mjs';
import { ensureNativePatchBinaryAvailable } from './native-server.mjs';
import { setPatchReplayPreSnapshots } from './replay-capture.mjs';
import { capturePatchRollbackState } from './rollback-state.mjs';
import { formatSequenceReport } from './sequence/report.mjs';
import { runPatchUnits } from './sequence/run.mjs';
import { buildPatchUnits } from './sequence/units.mjs';
import { registerCommittedPatchUiDiff } from './ui-diff.mjs';

export async function applyPatchSequence(patchStr, requestedFormat, basePath, ctx) {
  const {
    v4aConvertOpts,
    dryRun,
    fuzz,
    fuzzy,
    rejectPartial,
    readStateScope,
    abortSignal,
    mutationPlan,
    toolCallId,
    sessionId,
    replayCapture = null,
    continueAfterFailure = false,
    coalesceByFile = false,
  } = ctx;

  const units = buildPatchUnits(patchStr, requestedFormat, basePath, {
    v4aConvertOpts,
    dryRun,
    readStateScope,
    coalesceByFile,
  });
  if (units.length === 0) return 'Error: patch contained no file sections';

  try {
    await ensureNativePatchBinaryAvailable();
  } catch (err) {
    return `Error: ${err?.message || String(err)}`;
  }

  const lockPaths = [...new Set(units.flatMap((u) => [u.fullPath, ...(u.extraLockPaths || [])]))];
  const waveOpts = { fuzz, rejectPartial, dryRun, fuzzy, readStateScope, abortSignal };

  return withBuiltinPathLocks(lockPaths, () =>
    withAdvisoryLocks(lockPaths, async () => {
      let uiBeforeSnapshots = [];
      if (!dryRun && ((toolCallId && sessionId) || replayCapture)) {
        try {
          uiBeforeSnapshots = capturePatchRollbackState(lockPaths);
          setPatchReplayPreSnapshots(replayCapture, uiBeforeSnapshots);
        } catch {
          uiBeforeSnapshots = [];
        }
      }
      const outcome = await runPatchUnits(units, basePath, { waveOpts, abortSignal, continueAfterFailure });
      // Whatever reached disk is reported to the review channel; a full
      // success always has every unit in `applied`.
      if (!dryRun && uiBeforeSnapshots.length > 0 && outcome.applied.length > 0) {
        registerCommittedPatchUiDiff({
          callId: toolCallId,
          sessionId,
          basePath,
          beforeSnapshots: uiBeforeSnapshots,
          paths: lockPaths,
        });
      }
      const report = formatSequenceReport({
        units,
        outcome,
        dryRun,
        rejectedHunks: v4aConvertOpts?.rejectedHunks,
        continueAfterFailure,
      });
      return wrapPatchMutationOutput(report, mutationPlan, { executor: outcome.executor });
    })
  );
}

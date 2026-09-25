// apply_patch top-level orchestration: request intake → execution-path
// selection → ordered sequence or Codex batch, plus the executePatchTool
// entry point with replay capture. The pieces live beside this file:
//
//   ./apply-patch/request.mjs   — argument salvage + validation, abort signal,
//     base path and option flags.
//   ./apply-patch/route.mjs     — sequence vs Codex-batch vs rename-only.
//   ./apply-patch/codex-batch.mjs — validate-then-apply batch with rollback.
//   ./sequence.mjs              — ordered section mode (units / run / report).
//   ./wave.mjs                  — one unique-target wave via native + JS split.
//   ./read-redirects.mjs, ./rollback-state.mjs, ./section-coalesce.mjs,
//   ./post-patch-excerpts.mjs, ./mutation-output.mjs — shared steps.
//   ./ui-diff.mjs               — review-diff side channel (re-exported here).
//   ./replay-capture.mjs        — failure capture for `npm run patch:replay`.
import { assertPathReachable } from '../builtin/fs-reachability.mjs';
import { prepareCodexBatch, runCodexBatch, applyCodexBatchWithRollback } from './apply-patch/codex-batch.mjs';
import { resolveApplyPatchRequest } from './apply-patch/request.mjs';
import { selectApplyPatchRoute } from './apply-patch/route.mjs';
import { appendPostPatchExcerpts } from './post-patch-excerpts.mjs';
import { maybeCapturePatchReplay, preparePatchReplayCapture } from './replay-capture.mjs';
import { applyPatchSequence } from './sequence.mjs';
import { isPatchErrorText } from './wave.mjs';

export { takeApplyPatchUiDiff, registerEditToolUiDiff } from './ui-diff.mjs';

async function apply_patch(rawArgs, cwd, options = {}) {
  const request = await resolveApplyPatchRequest(rawArgs, cwd, options);
  const { args, patchStr, requestedFormat, readStateScope, abortSignal, basePath, rejectPartial, dryRun, fuzzy, fuzz } =
    request;
  try {
    await assertPathReachable(basePath);
  } catch (err) {
    return `Error: ${err?.message || String(err)}`;
  }
  const rejectedV4AHunks = [];
  const v4aConvertOpts = { rejectPartial, rejectedHunks: rejectedV4AHunks, fuzzy, dryRun, readStateScope };
  const route = selectApplyPatchRoute({ args, patchStr, requestedFormat, basePath, readStateScope });
  if (route.useSequence) {
    const seqOut = await applyPatchSequence(patchStr, requestedFormat, basePath, {
      v4aConvertOpts,
      dryRun,
      fuzz,
      fuzzy,
      rejectPartial,
      readStateScope,
      abortSignal,
      mutationPlan: request.mutationPlan,
      toolCallId: options?.toolCallId || null,
      sessionId: options?.sessionId || null,
      replayCapture: options?.replayCapture || null,
      continueAfterFailure: route.filePartial,
      coalesceByFile: route.filePartial,
    });
    return dryRun ? seqOut : appendPostPatchExcerpts(seqOut, patchStr, requestedFormat, basePath, readStateScope);
  }
  const batch = await prepareCodexBatch({
    patchStr,
    requestedFormat,
    basePath,
    readStateScope,
    preParsedV4ASections: route.preParsedV4ASections,
    v4aConvertOpts,
    mutationPlan: request.mutationPlan,
  });
  if (batch.error) return batch.error;
  return applyCodexBatchWithRollback({
    batch,
    basePath,
    dryRun,
    readStateScope,
    options,
    runBatch: () =>
      runCodexBatch({
        batch,
        basePath,
        v4aConvertOpts,
        rejectedV4AHunks,
        waveOpts: { fuzz, rejectPartial, dryRun, fuzzy, readStateScope, abortSignal },
      }),
  });
}

function reportPatchProgress(result, args, onProgress) {
  try {
    const _body = String(result);
    if (/^Error[\s:[]/.test(_body)) return;
    if (args?.dry_run === true) {
      onProgress('validated');
      return;
    }
    const _m = /^(?:applied|checked)\s+(\d+)\b/m.exec(_body);
    const _n = _m ? Number(_m[1]) : (_body.match(/^\s*OK\s/gm) || []).length;
    onProgress(`applied ${_n} files`);
  } catch {
    /* best-effort */
  }
}

export async function executePatchTool(name, args, cwd, options = {}) {
  const effectiveCwd = cwd || process.cwd();
  switch (name) {
    case 'apply_patch': {
      const replayCapture = preparePatchReplayCapture(args, effectiveCwd, options);
      let result;
      try {
        result = await apply_patch(args || {}, effectiveCwd, { ...options, replayCapture });
      } catch (err) {
        const errText = `Error: ${err?.message || String(err)}`;
        maybeCapturePatchReplay(replayCapture, errText);
        return errText;
      }
      if (isPatchErrorText(String(result))) maybeCapturePatchReplay(replayCapture, String(result));
      if (typeof options?.onProgress === 'function') reportPatchProgress(result, args, options.onProgress);
      return result;
    }
    default:
      throw new Error(`Unknown patch tool: ${name}`);
  }
}

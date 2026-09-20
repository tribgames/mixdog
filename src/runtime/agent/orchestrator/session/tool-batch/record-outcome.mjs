// Bookkeeping once a call has its result: envelope split, PostToolUseFailure
// hook, repeat-failure guards, argument-body restore for failed calls,
// cache invalidation after mutations, and the completed record finalize
// consumes.
import { resolve as resolvePath, isAbsolute } from 'node:path';
import { normalizeToolEnvelope } from '../tool-envelope.mjs';
import {
  invalidatePathForSession,
  clearReadDedupSession,
  extractTouchedPathsFromPatch,
  clearScopedToolsForSession,
  clearScopedToolsForSessionPaths,
  invalidatePrefetchCache,
} from '../read-dedup.mjs';
import {
  _stripMcpPrefix,
  _isMutationTool,
  _isGitMutationTool,
  _isShellTool,
  _isToolArgShapeFailure,
} from '../loop/tool-classify.mjs';
import { restoreToolCallBodyForId } from '../loop/stored-tool-args.mjs';

export async function recordCallOutcome(batch, call, exec, sigs, ctSig) {
  const { sessionId, sessionRef, cwd, epoch } = batch;
  // Central envelope normalize (general newMessages channel): every
  // execution path funnels into exec.result. Split ONCE here so downstream
  // post-processing sees only the model-visible result; newMessages ride
  // the per-batch buffer flushed after the batch's last tool_result.
  const envelope = normalizeToolEnvelope(exec.result);
  exec.result = envelope.result;
  if (envelope.newMessages.length) batch.newMessages.push(...envelope.newMessages);
  const failed = !exec.executeOk || exec.resultKind === 'error';
  const executed = exec.resultKind !== 'skipped';
  // A scoped-cache outcome recorded for this call.id is only consumed on
  // the success path in finalize; reclaim it here so a failed call cannot
  // leak its entry in sessionRef._scopedCacheOutcomeByCallId forever.
  if (failed && call?.id && sessionRef?._scopedCacheOutcomeByCallId instanceof Map) {
    sessionRef._scopedCacheOutcomeByCallId.delete(call.id);
  }
  if (executed && failed) await fireToolFailureHook(batch, call, exec.result);
  if (sessionRef && executed) updateRepeatFailureGuards(sessionRef, failed, exec.result, sigs);
  // A failed executed call keeps its FULL argument body in history so the
  // model can retry against the original (a large apply_patch `patch` would
  // otherwise hide behind a `[mixdog compacted …]` placeholder). Restored
  // immediately so an abort or post-processing throw cannot leave it
  // compacted; early-skipped calls stay compacted.
  if (executed && failed && call?.id) restoreToolCallBodyForId(batch.assistantTurnMsg, batch.calls, call.id);
  if (sessionId && _stripMcpPrefix(call.name) === 'apply_patch') {
    if (exec.executeOk && exec.resultKind === 'normal') invalidateAfterPatch(sessionId, call, cwd);
    // Mutation tools invalidate even on returned-error/partial-fail — the
    // file state is unknown after an error exit, and some tools report
    // failure as an Error: result string rather than throwing.
    if (failed) invalidateAfterFailedPatch(sessionId, call, cwd);
  }
  if (_isMutationTool(call.name, call.arguments)) epoch.mutation += 1;
  // Shell clears the scoped cache UNCONDITIONALLY — a mutating bash that
  // throws or fails partway can still leave stale find_symbol/grep entries.
  if (sessionId && executed && _isShellTool(call.name)) clearScopedToolsForSession(sessionId);
  // Git mutations (update-ref/reflog expire/gc/reset...) rewrite .git state
  // and possibly the working tree with no per-path visibility, so scoped
  // grep/glob/list/code_graph entries go stale: same policy as shell.
  if (sessionId && executed && _isGitMutationTool(call.name, call.arguments)) clearScopedToolsForSession(sessionId);
  batch.completed.push({
    call,
    ...exec,
    crossTurnSig: ctSig,
    mutationEpoch: epoch.mutation,
    nativeToolSearch: null,
    postError: null,
  });
}

// PostToolUseFailure: a tool that resolved to a failure (thrown-error path
// → `Error:` string, or an is_error result classified as 'error') fires the
// optional session failure hook. Best-effort — a hook error must never
// wedge the tool loop.
async function fireToolFailureHook(batch, call, result) {
  const { opts, sessionRef } = batch;
  const hook =
    typeof opts.afterToolFailureHook === 'function' ? opts.afterToolFailureHook : sessionRef?.afterToolFailureHook;
  if (typeof hook !== 'function') return;
  try {
    await hook({
      name: call.name,
      args: call.arguments,
      cwd: batch.cwd,
      sessionId: batch.sessionId,
      toolCallId: call.id,
      result: typeof result === 'string' ? result : String(result ?? ''),
    });
  } catch {
    /* best-effort: PostToolUseFailure hook must never break the loop */
  }
}

// Bump the consecutive-failure count for an identical signature, or clear
// the chain on ANY success: a successful different tool is the requested
// "change approach" and may have mutated the inputs/environment, so the old
// failure count no longer describes consecutive failures.
function updateRepeatFailureGuards(sessionRef, failed, result, sigs) {
  if (failed) {
    sessionRef._repeatFailGuard = bumpGuard(sessionRef._repeatFailGuard, sigs.repeatFail);
    const history = Array.isArray(sessionRef._repeatFailHistory) ? sessionRef._repeatFailHistory : [];
    history.push(sigs.repeatFail);
    if (history.length > 25) history.splice(0, history.length - 25);
    sessionRef._repeatFailHistory = history;
  } else {
    sessionRef._repeatFailGuard = null;
    sessionRef._repeatFailHistory = [];
  }
  sessionRef._repeatArgShapeFailGuard =
    failed && _isToolArgShapeFailure(result) ? bumpGuard(sessionRef._repeatArgShapeFailGuard, sigs.argShape) : null;
}

function bumpGuard(guard, sig) {
  return guard?.sig === sig ? { sig, count: guard.count + 1 } : { sig, count: 1 };
}

// Directory a patch's relative paths resolve against: an absolute base_path
// as-is, a relative one under cwd, else cwd itself.
function patchBaseDir(baseArg, cwd) {
  const fallback = cwd || process.cwd();
  if (typeof baseArg !== 'string' || baseArg.length === 0) return fallback;
  return isAbsolute(baseArg) ? baseArg : resolvePath(fallback, baseArg);
}

// apply_patch's args are a unified-diff text in `patch`. Parse the diff
// headers (`--- a/path` / `+++ b/path`) to invalidate each touched path
// (read dedup, prefetch, scoped tools); fall back to a full session clear
// when no paths could be parsed.
function invalidateAfterPatch(sessionId, call, cwd) {
  const base = patchBaseDir(call.arguments?.base_path, cwd);
  const touched = extractTouchedPathsFromPatch(call.arguments?.patch);
  if (touched.length > 0) {
    for (const p of touched) {
      invalidatePathForSession(sessionId, p, base);
      invalidatePrefetchCache(p, base);
    }
    clearScopedToolsForSessionPaths(sessionId, touched, base);
  } else {
    clearReadDedupSession(sessionId);
    clearScopedToolsForSession(sessionId);
  }
}

// Scoped caches are refreshed only on success, so a FAILED patch would
// otherwise leave later non-mutation tools in this batch reading stale
// entries for the possibly partially-written files.
function invalidateAfterFailedPatch(sessionId, call, cwd) {
  clearReadDedupSession(sessionId);
  const base = patchBaseDir(call.arguments?.base_path, cwd);
  const touched = extractTouchedPathsFromPatch(call.arguments?.patch);
  if (touched.length > 0) {
    clearScopedToolsForSessionPaths(sessionId, touched, base);
    for (const p of touched) invalidatePrefetchCache(p, base);
  } else {
    clearScopedToolsForSession(sessionId);
  }
}

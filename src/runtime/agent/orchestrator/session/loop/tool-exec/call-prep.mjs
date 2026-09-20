/**
 * call-prep.mjs — the per-call context every executor and hook reads: the
 * live cwd, coerced args, the scoped-cache outcome, the completion notifier
 * and the option bags handed to the tool.
 */
import { enqueuePendingMessage, markCompletionEntry, markSessionToolOutputTail } from '../../manager.mjs';
import { createScopedCacheOutcome } from '../../cache/scoped-cache-outcome.mjs';
import { modelVisibleToolCompletionMessage } from '../../../../../shared/tool-execution-contract.mjs';
import { _isScopedCacheableTool } from '../tool-classify.mjs';
import { refreshDeferredMcpToolCatalog } from '../../../../../../session-runtime/tool-catalog.mjs';
import { coerceToolArgsForSession } from '../arg-schema-coerce.mjs';

export function resolveToolCompletionSessionId({ callerSessionId } = {}) {
  return String(callerSessionId || '').trim();
}

export function resolveLiveToolCwd(cwd, sessionRef) {
  const liveCwd = typeof sessionRef?.cwd === 'string' ? sessionRef.cwd : '';
  return liveCwd || cwd;
}

function scopedCacheOutcomes(sessionRef) {
  // instanceof guard: a session revived from disk (JSON round-trip) turns
  // this Map into a plain object `{}` — truthy, but without Map methods.
  if (!(sessionRef._scopedCacheOutcomeByCallId instanceof Map)) sessionRef._scopedCacheOutcomeByCallId = new Map();
  return sessionRef._scopedCacheOutcomeByCallId;
}

export function _scopedCacheOutcomeForCall(sessionRef, toolCallId, toolName, callerSessionId, executeOpts = {}) {
  if (executeOpts.scopedCacheOutcome) {
    if (sessionRef && toolCallId) scopedCacheOutcomes(sessionRef).set(toolCallId, executeOpts.scopedCacheOutcome);
    return executeOpts.scopedCacheOutcome;
  }
  if (!callerSessionId || !toolCallId || !_isScopedCacheableTool(toolName)) return null;
  const outcome = createScopedCacheOutcome();
  if (sessionRef) scopedCacheOutcomes(sessionRef).set(toolCallId, outcome);
  return outcome;
}

/** Route a background tool's completion to the session that invoked it. */
function completionNotifier(notificationSessionId) {
  return (text, meta = {}) => {
    if (!notificationSessionId) return;
    try {
      const visible = modelVisibleToolCompletionMessage(text, meta);
      // Inherently a tool-completion notification → tag so a later
      // resume drops it instead of replaying it as user text.
      if (visible) {
        enqueuePendingMessage(
          notificationSessionId,
          markCompletionEntry(visible, {
            executionId: meta?.execution_id,
            meta,
          })
        );
      }
    } catch {
      /* best effort */
    }
  };
}

export function prepareToolCall(name, args, cwd, callerSessionId, sessionRef, executeOpts) {
  // cwd is captured when the turn starts. The deferred cwd tool updates
  // sessionRef.cwd in place, so every later tool call must re-read that live
  // value instead of continuing to use the stale turn snapshot.
  const liveCwd = resolveLiveToolCwd(cwd, sessionRef);
  refreshDeferredMcpToolCatalog(sessionRef);
  // Structured arguments that arrived as JSON text take their declared shape
  // before any hook or executor reads them.
  const coercedArgs = coerceToolArgsForSession(sessionRef, name, args);
  const scopedCacheOutcome = _scopedCacheOutcomeForCall(
    sessionRef,
    executeOpts.toolCallId,
    name,
    callerSessionId,
    executeOpts
  );
  const toolOpts = scopedCacheOutcome ? { ...executeOpts, scopedCacheOutcome } : executeOpts;
  // A background tool belongs to the session that invoked it. Subagent
  // sessions carry the top-level UI session in ownerSessionId, but routing a
  // shell completion there leaks the child task into the lead transcript.
  const notificationSessionId = resolveToolCompletionSessionId({
    callerSessionId,
    ownerSessionId: sessionRef?.ownerSessionId,
    requestedNotificationSessionId: executeOpts.notifySessionId,
  });
  const notifyFn =
    typeof executeOpts.notifyFn === 'function' ? executeOpts.notifyFn : completionNotifier(notificationSessionId);
  const completionToolOpts = {
    ...toolOpts,
    sessionId: callerSessionId,
    agent: sessionRef?.agent || null,
    callerSessionId: notificationSessionId || callerSessionId,
    routingSessionId: callerSessionId,
    clientHostPid: sessionRef?.clientHostPid,
    notifyFn,
    // Live shell-output tail → session liveness (~1 s cadence from the
    // shell tool's tail timer), surfaced to transcript consumers (desktop
    // running tool cards) via getSessionProgressSnapshot.
    onOutputTail: (tail) => {
      try {
        markSessionToolOutputTail(callerSessionId, tail);
      } catch {
        /* best effort */
      }
    },
  };
  return { cwd: liveCwd, args: coercedArgs, toolOpts, notifyFn, completionToolOpts };
}

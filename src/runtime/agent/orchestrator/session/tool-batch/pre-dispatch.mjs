// Guards that resolve a call without executing it: session tool-surface
// deny, Computer Use cardinality, intra-turn and cross-turn dedup stubs,
// and the repeat-failure / argument-shape guards. `skip` is the staged tool
// message for a resolved call, or null when the call may execute.
import { appendAgentTrace } from '../../agent-trace.mjs';
import { _argShapeSig, _repeatFailureSig, _repeatFailurePatternWouldContinue } from '../loop/tool-classify.mjs';
import { preDispatchDenyForSession } from '../loop/pre-dispatch-deny.mjs';
import { crossTurnSignature, crossTurnDedupStub } from '../loop/completion-guards.mjs';
import { getToolKind, isToolCallDedupEligible } from '../loop/tool-helpers.mjs';

export function preDispatchSkip(batch, call) {
  const { plan, sessionRef, tools } = batch;
  const skipped = (content, toolKind, ctSig = null) => ({
    skip: { role: 'tool', content, toolCallId: call.id, toolKind },
    ctSig,
    sigs: null,
  });
  // A cached or deduplicated result cannot bypass the current session's
  // tool surface, including after a profile change.
  const denied = preDispatchDenyForSession(sessionRef, call, getToolKind(call.name, sessionRef?.mcpScopeId));
  if (denied !== null) return skipped(denied, 'error');
  if (plan.singleCallBlockedIds.has(call.id)) {
    const firstId = plan.singleCallFirstIdByName.get(call.name);
    return skipped(
      `[computer-call-cardinality] Only the first Computer Use call in an assistant turn is executed (tool_use_id=${firstId}). This call was not executed. Inspect the first call's fresh result, then issue at most one next computer call; use sequence only for a deterministic same-window focus chain.`,
      'error'
    );
  }
  if (plan.duplicateCallIds.has(call.id)) {
    const firstId = plan.dupFirstId.get(call.id);
    // Explicitly NOT a success: no tool executed for this call. 'skipped'
    // keeps the transcript/UI non-error while the unresolved-tool-failure
    // stop hook refuses to count it as the executed success that would
    // resolve a prior failure.
    return skipped(
      `[intra-turn-dedup] identical read-only \`${call.name}\` call was already executed in this same assistant turn as tool_use_id=${firstId}. The first call's tool_result is in context immediately above; skipping re-execution to save tokens. If you needed a different slice of the file, narrow the next call (different path / offset / limit / pattern) so it has a distinct signature.`,
      'skipped'
    );
  }
  // Per-call cross-turn signature, computed at most once and only for
  // dedup-eligible calls (both consumer sites are eager-gated).
  let ctSig = null;
  if (isToolCallDedupEligible(call.name, tools)) {
    ctSig = crossTurnSignature(call.name, call.arguments);
    const stub = crossTurnStub(batch, call, ctSig);
    if (stub !== null) return skipped(stub, 'skipped', ctSig);
  }
  const sigs = {
    repeatFail: _repeatFailureSig(call.name, call.arguments, batch.cwd),
    argShape: _argShapeSig(call.name, call.arguments),
  };
  return { skip: repeatFailureSkip(batch, call, sigs), ctSig, sigs };
}

// Cross-turn identical-call stub: a SUCCESSFUL read-only dedup-eligible
// call whose (name,args) signature already ran in an EARLIER turn is not
// re-executed — its result is unchanged and already in context. Warn at
// the 2nd occurrence; append the "stuck" escalation tail once the session
// has emitted 5+ dedup stubs total. Never applies to write/bash/MCP/skill
// tools (not eager-dispatchable).
function crossTurnStub(batch, call, ctSig) {
  const prior = batch.crossTurnCalls.get(ctSig);
  if (!prior || prior.firstIteration >= batch.iterations) return null;
  prior.count += 1;
  batch.dedupStubTotal += 1;
  const stub = crossTurnDedupStub(call.name, prior.firstIteration, batch.dedupStubTotal >= 5);
  try {
    appendAgentTrace({
      sessionId: batch.sessionId,
      iteration: batch.iterations,
      kind: 'steer',
      payload: {
        tag: 'cross_turn_dedup',
        tool: call.name,
        occurrence: prior.count,
        first_iteration: prior.firstIteration,
        dedup_stub_total: batch.dedupStubTotal,
      },
      agent: batch.sessionAgent || null,
    });
  } catch {
    /* best-effort */
  }
  return stub;
}

// Cross-iteration repeat-failure guard. Distinct from the intra-turn dedup
// (which spans ONE assistant turn): when the model re-issues an IDENTICAL
// normalized call that has already failed repeatFailLimit times in a row
// across iterations, stop re-executing — the result will not change, and
// each retry burns a full LLM round-trip until the hard iteration cap. The
// call stays unresolved; the guard only skips re-execution.
function repeatFailureSkip(batch, call, sigs) {
  const { sessionRef, repeatFailLimit } = batch;
  const rfg = sessionRef?._repeatFailGuard;
  const cycleLength = _repeatFailurePatternWouldContinue(
    sessionRef?._repeatFailHistory,
    sigs.repeatFail,
    repeatFailLimit
  );
  if ((rfg && rfg.sig === sigs.repeatFail && rfg.count >= repeatFailLimit) || cycleLength > 0) {
    const detail =
      cycleLength > 1
        ? `A ${cycleLength}-call normalized failure pattern repeated ${repeatFailLimit} times`
        : `Identical normalized \`${call.name}\` call failed ${rfg?.count ?? repeatFailLimit} times`;
    return {
      role: 'tool',
      content: `[repeat-failure-guard] ${detail}; not re-executed. Retry only after its inputs or subject change; otherwise leave it unresolved.`,
      toolCallId: call.id,
      toolKind: 'error',
    };
  }
  const afg = sessionRef?._repeatArgShapeFailGuard;
  if (afg && afg.sig === sigs.argShape && afg.count >= repeatFailLimit) {
    return {
      role: 'tool',
      content: `[repeat-argument-shape-guard] Equivalent malformed \`${call.name}\` arguments failed validation ${afg.count} times; not re-executed. Correct required fields or types before retrying.`,
      toolCallId: call.id,
      toolKind: 'error',
    };
  }
  return null;
}

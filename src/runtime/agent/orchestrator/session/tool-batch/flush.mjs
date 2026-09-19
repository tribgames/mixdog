// Ordered commit of the batch: tool_results in the assistant's tool_use
// order, then the newMessages channel, the batching nudge, and the
// PostToolBatch hook — all before the next provider send.
import { envFlag } from '../../../../shared/env.mjs';
import { skillBodyPresentInSession } from '../../context/collect.mjs';
import { isInjectedSkillBodyMessage } from '../compact/messages.mjs';
import { appendAgentTrace } from '../../agent-trace.mjs';
import { updateSessionStage } from '../manager.mjs';
import { observeToolBatchForNudge, batchingNudgeMessage } from '../batching-nudge.mjs';

export async function flushBatch(batch) {
  const { calls, pushToolResultMessage, sessionId } = batch;
  // Early dedup/guard skips and deferred execution results share this
  // ordered flush so provider tool_result blocks always follow the
  // assistant's original tool_use order.
  for (const call of calls) {
    const message = batch.resultByCallId.get(call?.id);
    if (message) pushToolResultMessage(message);
  }
  for (const message of batch.resultsWithoutId) pushToolResultMessage(message);
  flushNewMessages(batch);
  nudgeBatching(batch);
  await runAfterToolBatchHook(batch);
  // Mid-turn steering is drained at the next loop's pre-send point, AFTER
  // any auto-compact pass, so compaction never treats these fresh tool
  // results as prior history before the model sees them. About to re-send
  // with tool results — back to connecting for the next turn.
  if (sessionId) updateSessionStage(sessionId, 'connecting');
}

// All tool_results for this assistant turn are pushed; the injected
// role:'user' messages go AFTER the last tool_result and BEFORE the next
// provider send, so no user message lands between tool(A) and tool(B).
// pre-send repairTranscriptBeforeProviderSend normalizes any residual
// ordering. Their meta flag (e.g. meta:'skill') keeps compaction's
// latest-human-prompt selection from mistaking them for the user's request.
function flushNewMessages(batch) {
  const { messages } = batch;
  for (const nm of batch.newMessages) {
    if (nm?.role !== 'user' || typeof nm.content !== 'string' || !nm.content) continue;
    // Equivalent Skill calls can finish eagerly before either body reaches
    // the live transcript: deduplicate at the shared commit boundary too,
    // without dropping changed bodies or tool outcomes.
    if (isInjectedSkillBodyMessage(nm) && skillBodyPresentInSession({ messages }, nm.content.trimStart())) continue;
    messages.push({ role: 'user', content: nm.content, ...(nm.meta ? { meta: nm.meta } : {}) });
  }
}

// Tool-batching reminder, only once the transcript shows serial calls that
// did not need each other's results, or same-tool scalar calls
// (batching-nudge.mjs). Rides the channel the flush above just used, so
// tool_result pairing stays valid. MIXDOG_ROUND_REMINDER=0 silences the
// route's per-round line; the batching heuristics keep their own triggers.
function nudgeBatching(batch) {
  const { opts, calls, messages } = batch;
  const roundReminderOn = !opts.roundReminderByProvider && envFlag('MIXDOG_ROUND_REMINDER', true);
  const nudge = observeToolBatchForNudge({
    sessionRef: batch.sessionRef,
    calls,
    results: calls.map((call) => batch.resultByCallId.get(call.id) ?? null),
    tools: batch.tools,
    reminder: roundReminderOn ? opts.roundReminder || null : null,
  });
  if (!nudge) return;
  messages.push(batchingNudgeMessage(nudge));
  try {
    appendAgentTrace({
      sessionId: batch.sessionId,
      iteration: batch.iterations,
      kind: 'batching_nudge',
      payload: { trigger: nudge.trigger, tools: nudge.tools },
    });
  } catch {
    /* best-effort */
  }
}

// PostToolBatch: the full parallel batch for this assistant turn has
// resolved and every tool_result is pushed; fire the optional session hook
// before the next model call. A blocked===true decision injects its reason
// as a system-note user message for the next send (the same channel the
// newMessages flush just used). Best-effort otherwise.
async function runAfterToolBatchHook(batch) {
  const { opts, sessionRef, calls, messages } = batch;
  const hook = typeof opts.afterToolBatchHook === 'function' ? opts.afterToolBatchHook : sessionRef?.afterToolBatchHook;
  if (typeof hook !== 'function' || calls.length === 0) return;
  try {
    const decision = await hook({ sessionId: batch.sessionId, cwd: batch.cwd, toolCount: calls.length });
    if (decision?.blocked === true) {
      const reason = String(decision.reason || 'PostToolBatch hook blocked continuation').trim();
      if (reason) {
        messages.push({ role: 'user', content: `<system-reminder>\n${reason}\n</system-reminder>`, meta: 'hook' });
      }
    }
  } catch {
    /* best-effort: PostToolBatch hook must never break the loop */
  }
}

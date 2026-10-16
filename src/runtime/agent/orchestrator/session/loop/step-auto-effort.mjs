/**
 * step-auto-effort.mjs — auto effort for each tool-result step of a turn.
 * After a tool batch the effort judge rates the decision the model faces next
 * (the turn's request, the step number, the model's text of this round, its
 * calls and their results); the judged effort is stored on the batch's last
 * tool result, where effort-configuration.mjs turns it into the provider's
 * mid-conversation effort change. The mark lives in the transcript, so every
 * later request rebuilds the same history and the prompt cache keeps hitting.
 * A judge that is missing, slow or failing leaves the step at the effort in
 * force (the turn's or the previous step's).
 * A custom route snaps the judged effort onto the model's levels. Without a
 * mid-conversation update (snapshot mode 'custom') it becomes the effort of
 * the turn's following requests; a custom GPT-6+ Responses route (mode
 * 'responses') also marks it as the update.
 */
import { resolveAutoEffort } from '../../providers/auto-effort.mjs';
import { isCustomProviderName, resolveCustomReasoning } from '../../providers/custom-reasoning.mjs';
import { autoEffortModel, stepEffortConfiguration } from '../../providers/effort-configuration.mjs';
import { effortOptionsFor, warnEmptyAutoEffortLadder } from '../../runtime-core/effort.mjs';
import { judgeTurn, recordEffortDecision } from '../../../../effort-judge/judge-client.mjs';
import { stepResultWindow } from '../../../../effort-judge/judge-input.mjs';

const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text']);
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && TEXT_BLOCKS.has(block.type))
    .map((block) => block.text)
    .join('\n');
}
// Same argument text the training data was built from (head 600 code points).
const argText = (args) =>
  Array.from(typeof args === 'string' ? args : JSON.stringify(args ?? {}))
    .slice(0, 600)
    .join('');

// A judgment runs beside the next iteration instead of in front of it. Its
// record lives on the loop state (`state.stepEffort`), so it can only ever
// reach the turn that started it; its promise settles the record and touches
// nothing else, so an aborted loop is never mutated afterwards. The result
// lands on the batch's last tool result in one of two places:
//  - resolved before the next request is projected: on that tool result, so
//    the request carries it (applyStepEffort);
//  - resolved later: the request already went out with the earlier effort and
//    its history is never rewritten (that would break the prompt cache), so
//    the result marks the last tool result of the next batch, and the
//    following request carries it (markStepEffort).
function applyResult(state, target, result) {
  if (result.level) state.opts.effort = result.level;
  if (result.marked) target.meta = { ...target.meta, effortConfiguration: result.marked };
}

// How long a request waits for its step judgment (measured judge p90 ≈ 284 ms).
export const STEP_EFFORT_GRACE_MS = 300;

/**
 * Before a provider request is projected: wait up to the grace for the pending
 * judgment and apply it if it resolved. A slower one leaves this request at
 * the effort in force and lands on the following request.
 */
export async function applyStepEffort(state) {
  const pending = state.stepEffort;
  if (!pending || pending.sent) return;
  if (!pending.settled && !state.signal?.aborted) {
    let timer;
    await Promise.race([
      pending.promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, STEP_EFFORT_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
    // Another caller may have handled it while this one waited.
    if (pending.sent) return;
  }
  pending.sent = true;
  if (!pending.result || state.signal?.aborted || !state.messages.includes(pending.target)) return;
  applyResult(state, pending.target, pending.result);
  pending.applied = true;
}

/**
 * Start judging the step after this batch (not awaited). The result applies to
 * the next request if it is ready by then, else to the one after.
 * `state.opts.stepAutoEffort` ({ request, base }) is set only when auto effort
 * is on for this turn and the installed judge was trained on steps.
 */
export function markStepEffort(state, assistantTurnMsg) {
  const auto = state.opts?.stepAutoEffort;
  const snapshot = state.opts?.effortConfiguration;
  if (!auto || !snapshot || state.signal?.aborted) return;
  const calls = Array.isArray(assistantTurnMsg?.toolCalls) ? assistantTurnMsg.toolCalls : [];
  const ids = new Set(calls.map((call) => call.id));
  const results = new Map();
  let last = null;
  for (const message of state.messages) {
    if (message?.role === 'tool' && ids.has(message.toolCallId)) {
      results.set(message.toolCallId, message);
      last = message;
    }
  }
  if (!last) return;
  const previous = state.stepEffort;
  if (previous) {
    // It resolved after its request went out: this batch carries it. One still
    // running is superseded: the newest step's judgment queues behind it and
    // any judgment still waiting in between is skipped (latest wins), so the
    // judge never has more than one running and one queued.
    if (previous.settled) {
      if (previous.result && !previous.applied) applyResult(state, last, previous.result);
    } else {
      previous.superseded = true;
    }
  }
  state.autoEffortSteps = (state.autoEffortSteps || 0) + 1;
  const step = state.autoEffortSteps;
  const provider = state.sessionRef?.provider;
  const model = state.model;
  const pending = { target: last, sent: false, settled: false, applied: false, superseded: false, result: null };
  const behind = previous && !previous.settled ? previous.promise : Promise.resolve();
  state.stepEffort = pending;
  const context = { auto, snapshot, step, provider, model, providerClient: state.provider, sessionId: state.sessionId };
  const input = {
    step: {
      request: auto.request,
      step,
      plan: textOf(assistantTurnMsg.content),
      calls: calls.map((call) => ({
        name: call.name,
        args: argText(call.arguments),
        result: stepResultWindow(textOf(results.get(call.id)?.content)),
      })),
    },
  };
  pending.promise = behind
    .then(() => (pending.superseded ? null : judgeTurn(input)))
    .then((judged) => (judged ? stepResult(context, judged) : null))
    // A failed judgment leaves the step at the effort in force.
    .catch(() => null)
    .then((result) => {
      // Only this record changes here; the loop reads it at its next boundary.
      pending.result = result;
      pending.settled = true;
    });
}

// What a resolved judgment sets: `{ marked, level }` (the tool result's effort
// configuration, and the per-request effort of a custom route), or null.
function stepResult({ auto, snapshot, step, provider, model, providerClient, sessionId }, judged) {
  // `atStep` numbers the tool-result step; `step` in a resolved decision is the ladder move.
  const record = {
    at: new Date().toISOString(),
    sessionId,
    provider,
    model,
    mode: 'on',
    atStep: step,
  };
  if (!judged.probs) {
    recordEffortDecision({ ...record, skipped: judged.skipped });
    return null;
  }
  const modelMeta = autoEffortModel(provider, providerClient, model);
  const resolved = resolveAutoEffort({
    base: auto.base,
    options: effortOptionsFor(provider, modelMeta),
    probs: judged.probs,
  });
  recordEffortDecision({
    ...record,
    ...(resolved || { skipped: 'default-outside-auto-range' }),
    ms: judged.ms,
    probs: judged.probs.map((value) => Number(value.toFixed(3))),
  });
  if (!resolved) warnEmptyAutoEffortLadder(provider, model, auto.base);
  if (isCustomProviderName(provider)) {
    const level =
      resolved &&
      resolveCustomReasoning({
        protocol: providerClient?.customConfig?.protocol,
        model: modelMeta,
        effort: resolved.effort,
      }).level;
    if (!level) return null;
    // The per-request effort also carries the step on an update route,
    // where a rejected update replays the request with it.
    return {
      level,
      marked:
        snapshot.mode === 'custom'
          ? { ...snapshot, effort: level }
          : stepEffortConfiguration(snapshot, provider, model, level),
    };
  }
  const marked = resolved && stepEffortConfiguration(snapshot, provider, model, resolved.effort);
  return marked ? { level: null, marked } : null;
}

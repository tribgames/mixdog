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
 */
import { resolveAutoEffort } from '../../providers/auto-effort.mjs';
import { stepEffortConfiguration } from '../../providers/effort-configuration.mjs';
import { effortOptionsFor } from '../../runtime-core/effort.mjs';
import { judgeTurn, recordEffortDecision } from '../../../../effort-judge/judge-client.mjs';
import { stepResultWindow } from '../../../../effort-judge/judge-input.mjs';

const TEXT_BLOCKS = new Set(['text', 'input_text', 'output_text']);
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => block && TEXT_BLOCKS.has(block.type))
          .map((block) => block.text)
          .join('\n')
      : '';
// Same argument text the training data was built from (head 600 code points).
const argText = (args) =>
  Array.from(typeof args === 'string' ? args : JSON.stringify(args ?? {}))
    .slice(0, 600)
    .join('');

/**
 * Judge the step after this batch and mark its last tool result.
 * `state.opts.stepAutoEffort` ({ request, base }) is set only when auto effort
 * is on for this turn and the installed judge was trained on steps.
 */
export async function markStepEffort(state, assistantTurnMsg) {
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
  state.autoEffortSteps = (state.autoEffortSteps || 0) + 1;
  const step = state.autoEffortSteps;
  const provider = state.sessionRef?.provider;
  const model = state.model;
  const judged = await judgeTurn({
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
  });
  // `atStep` numbers the tool-result step; `step` in a resolved decision is the ladder move.
  const record = { at: new Date().toISOString(), sessionId: state.sessionId, provider, model, mode: 'on', atStep: step };
  if (!judged.probs) {
    recordEffortDecision({ ...record, skipped: judged.skipped });
    return;
  }
  const resolved = resolveAutoEffort({
    base: auto.base,
    options: effortOptionsFor(provider, { id: model }),
    probs: judged.probs,
  });
  recordEffortDecision({
    ...record,
    ...(resolved || { skipped: 'default-outside-auto-range' }),
    ms: judged.ms,
    probs: judged.probs.map((value) => Number(value.toFixed(3))),
  });
  const marked = resolved && stepEffortConfiguration(snapshot, provider, model, resolved.effort);
  if (marked) last.meta = { ...last.meta, effortConfiguration: marked };
}

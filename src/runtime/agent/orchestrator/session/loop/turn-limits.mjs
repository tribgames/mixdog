/**
 * turn-limits.mjs — a turn's caps (sendOpts.turnLimits; a heartbeat turn's,
 * manager/ask-turn-loop-options.mjs): `maxToolCalls` tool calls and
 * `wrapUpAt` (epoch ms). A call past the cap, or one made after the wrap-up
 * time, is answered without running. Once a cap is reached the model is told
 * to reply, and every later request of the turn forbids tool use
 * (toolChoice 'none'). A response that still calls tools after that ends the
 * turn with no reply, its calls answered unrun. A capped turn runs no call
 * eagerly (eager-dispatch.mjs), so none past the cap starts while streaming.
 */

const NOTICE =
  '[mixdog-runtime] This turn has reached its tool-call or time limit: no further tool call runs. Reply now with your final answer from what you already have.';
const REFUSAL =
  '[turn-limit] This turn has reached its tool-call or time limit; this call was not run. Reply now without tools.';

/** `{ maxToolCalls, wrapUpAt }` of a capped turn (Infinity where unset), else null. */
export function turnLimitsOf(opts) {
  const limits = opts?.turnLimits;
  if (!limits || typeof limits !== 'object') return null;
  return {
    maxToolCalls: Number.isInteger(limits.maxToolCalls) && limits.maxToolCalls >= 0 ? limits.maxToolCalls : Infinity,
    wrapUpAt: Number.isFinite(limits.wrapUpAt) ? limits.wrapUpAt : Infinity,
  };
}

/** How many calls of the next batch may run, before the loop counts them. */
export function callsAllowed(state, now = Date.now()) {
  const limits = turnLimitsOf(state.opts);
  if (!limits) return Infinity;
  if (state.turnLimitNoticed || now >= limits.wrapUpAt) return 0;
  return Math.max(0, limits.maxToolCalls - state.toolCallsTotal);
}

/** The answer to a call the cap kept from running. */
export function turnLimitRefusal(call) {
  return { role: 'tool', content: REFUSAL, toolCallId: call.id, toolKind: 'error' };
}

/**
 * After a tool batch: `overrun` when the batch came after the turn was told
 * to reply, which ends the turn (state.turnLimitEnded). Otherwise, once a cap
 * is reached, the model is told once to reply.
 */
export function settleTurnLimits(state, overrun, now = Date.now()) {
  if (overrun) {
    state.turnLimitEnded = true;
    return;
  }
  const limits = turnLimitsOf(state.opts);
  if (!limits || state.turnLimitNoticed) return;
  if (state.toolCallsTotal < limits.maxToolCalls && now < limits.wrapUpAt) return;
  state.turnLimitNoticed = true;
  state.messages.push({ role: 'user', content: NOTICE, meta: { source: 'turn-limit' } });
}

/** The turn's end after an overrun: no reply. */
export function endedWithoutReply(response) {
  return { ...response, content: '', toolCalls: [] };
}

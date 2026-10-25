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
import { createHash } from 'node:crypto';
import { crossTurnSignature } from './completion-guards.mjs';
import { roomDataLines } from '../agent-room.mjs';

const PARTIAL_LABEL = 'Partial reply before the stop:';

const NOTICE =
  '[mixdog-runtime] This turn has reached its tool-call or time limit: no further tool call runs. Reply now with your final answer from what you already have.';
const REFUSAL =
  '[turn-limit] This turn has reached its tool-call or time limit; this call was not run. Reply now without tools.';

// Every turn, capped or not, has two backstops against a model that keeps
// being called without converging (reasoning on and on, re-prompted by
// recovery nudges, varying calls that all fail or are refused): a step limit
// on provider calls since the turn last made progress (a tool round in which
// some call produced a result the turn had not seen), and a run of tool
// rounds with no new result.
// Productive tool work is never capped. Neither is a stall timer — a
// streaming model never trips one. Reaching either tells the model once to
// reply without tools (a tool call after that ends the turn), and no
// provider call runs past the step limit plus that one reply.
const envLimit = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
export const STEP_LIMIT = envLimit('MIXDOG_TURN_STEP_LIMIT', 30);
export const NO_PROGRESS_ROUND_LIMIT = envLimit('MIXDOG_NO_PROGRESS_ROUND_LIMIT', 8);
const STEP_NOTICE = (reason) =>
  `[mixdog-runtime] This turn has ${reason}: no further tool call runs. Reply now with your final answer from what you already have, including what is still unresolved.`;
const STEP_STOP = (reason) => `[mixdog-runtime] Stopped: this turn ${reason} without a final answer.`;

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
  if (state.turnLimitNoticed) return 0;
  const limits = turnLimitsOf(state.opts);
  if (!limits) return Infinity;
  if (now >= limits.wrapUpAt) return 0;
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

/** The turn's end after an overrun: no reply, or the step-limit stop. */
export function endedWithoutReply(response, state) {
  if (state?.stepLimitReached) return stepLimitResponse(response, state);
  return { ...response, content: '', toolCalls: [] };
}

// Told once to reply; a capped turn already told keeps its own notice.
function noticeStepLimit(state, reason) {
  state.stepLimitReached ||= reason;
  if (state.turnLimitNoticed) return;
  state.turnLimitNoticed = true;
  state.messages.push({ role: 'user', content: STEP_NOTICE(reason), meta: { source: 'turn-limit' } });
}

/**
 * Before each provider call: true when the turn must end now. The call that
 * reaches the step limit is followed by one more, told to reply without
 * tools; nothing runs after that one.
 */
export function stepLimitSpent(state) {
  if (state.callsSinceProgress < STEP_LIMIT) return false;
  if (state.callsSinceProgress > STEP_LIMIT) return true;
  noticeStepLimit(state, `reached its step limit (${STEP_LIMIT} model calls without progress)`);
  return false;
}

/** The turn's end at the step limit: a visible stop, never a silent finish.
 *  The notice leads; whatever the model had said last follows it under a
 *  label, as data (an echoed copy of the notice dropped, runtime-marked lines
 *  defused), so the Lead keeps the partial answer without a second notice. */
export function stepLimitResponse(response, state) {
  const notice = STEP_STOP(state.stepLimitReached);
  const said = typeof response?.content === 'string' ? response.content.split(notice).join('').trim() : '';
  const partial = said ? `\n\n${PARTIAL_LABEL}\n${roomDataLines(said).join('\n')}` : '';
  return { ...response, content: `${notice}${partial}`, toolCalls: [], stepLimitStopped: true };
}

// Waiting calls may return the same result while the awaited work runs:
// sleep and `task` with action 'wait'. Reads of the same job (task
// list/read/cancel, agent status/list/read) are not waiting.
const toolBaseName = (name) =>
  String(name || '')
    .split(/[/.]/)
    .pop()
    .toLowerCase();
function callArgs(args) {
  if (typeof args !== 'string') return args;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}
const isWaitCall = (call) => {
  const name = toolBaseName(call.name);
  return name === 'sleep' || (name === 'task' && callArgs(call.arguments)?.action === 'wait');
};

// A result is new evidence unless this turn already saw the same call return
// the same text: a model replaying a call that succeeds identically makes no
// more progress than one whose calls fail.
function isNewResult(state, call, message) {
  if (!call || isWaitCall(call) || typeof message.content !== 'string') return true;
  const key = createHash('sha256')
    .update(crossTurnSignature(call.name, call.arguments))
    .update('\0')
    .update(message.content)
    .digest('hex');
  if (state.seenToolResults.has(key)) return false;
  state.seenToolResults.add(key);
  return true;
}

/**
 * After a tool batch: a round in which every call failed, was refused unrun
 * ('error' / 'skipped'), or returned a result this turn already saw made no
 * progress. Enough of them in a row tell the model to reply, like the step
 * limit; any other round restarts both counts.
 */
export function settleToolProgress(state, results, calls = []) {
  const byId = new Map(calls.map((call) => [call.id, call]));
  let progressed = false;
  for (const message of results) {
    if (message?.role !== 'tool' || message.toolKind === 'error' || message.toolKind === 'skipped') continue;
    if (isNewResult(state, byId.get(message.toolCallId), message)) progressed = true;
  }
  if (progressed) state.callsSinceProgress = 0;
  state.noProgressRounds = progressed ? 0 : state.noProgressRounds + 1;
  if (state.noProgressRounds < NO_PROGRESS_ROUND_LIMIT) return;
  noticeStepLimit(state, `run ${NO_PROGRESS_ROUND_LIMIT} tool rounds in a row in which no call produced a new result`);
}

/**
 * A routine fire (schedule or webhook) is a TURN in its owner bot's home
 * thread (`sess_home_<agentId>`): the routine's instructions are delivered
 * there as a queued turn the bot handles itself — doing it or delegating as
 * in any turn — and its reply in the chat is the result. Nothing else is
 * created: no run session, no result card.
 *
 * The turn waits behind the thread's own work (a user turn, another routine):
 * it rides the thread's queue as its own `routine` entry (one per turn, never
 * merged or steered into another), shows as a routine marker row, and selects
 * skills only from the routine's instructions (`skillSelection`), never from a
 * webhook payload. While it runs the thread counts as an unattended run
 * (held-requests.mjs): the saved routine is the user's grant, so it never asks
 * (outbound actions are allowed within the bot's permissions; payments and
 * permanent deletes are refused, human-gate/run-policy.mjs). Resolves with the
 * reply once the turn ends; rejects when the turn fails, is cancelled, or the
 * caller's `signal` aborts (which also aborts the turn once it runs).
 */
import { randomUUID } from 'node:crypto';
import { agentHomeSessionId } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import { routineHumanNeededText } from '../runtime/agent/orchestrator/session/routine-result.mjs';
import { automationPromptContent } from '../runtime/shared/automation-attachments.mjs';
import { ROUTINE_LIMITS } from '../runtime/shared/routine-limits.mjs';
import { normalizeRoutineTrigger, routineTriggerHeader } from '../runtime/shared/routine-trigger.mjs';
import { agentHomeLiveSurface, scheduleOwnerAgentId } from './agent-home-delivery.mjs';
import { markUnattendedRun, unattendedRunOf } from './held-requests.mjs';

// Routine turns waiting or running per home thread.
const waiting = new Map();

const abortError = (signal) =>
  signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || 'routine run aborted'));

async function defaultLoadSession(sessionId) {
  const { loadSession } = await import('../runtime/agent/orchestrator/session/store.mjs');
  return loadSession(sessionId);
}

function settledError(detail) {
  if (detail?.status === 'cancelled') return new Error('the routine turn was cancelled');
  if (detail?.status === 'rejected') return new Error("the bot's chat closed before the routine ran");
  const error = detail?.error;
  return new Error(String(error?.message || error || 'the routine turn failed'));
}

/**
 * Deliver one fire of routine `name` (`kind` schedule | webhook) to its
 * owner's home thread. `prompt` is the model-visible body (instructions, plus
 * a webhook's fenced payload); `skillSelection` its trusted part (default:
 * the whole body); `event` a short label for the marker (webhook event).
 */
export async function runRoutineTurn(
  {
    kind,
    name,
    ownerAgentId = null,
    prompt,
    skillSelection = null,
    attachments = null,
    cwd = null,
    event = '',
    signal = null,
  },
  {
    surface = agentHomeLiveSurface(),
    loadSession = defaultLoadSession,
    limit = ROUTINE_LIMITS.homeQueueLimit,
    log = (line) => process.stderr.write(`mixdog routines: ${line}\n`),
  } = {}
) {
  const body = String(prompt || '').trim();
  if (!body) throw new Error(`${kind} "${name}" has no instructions`);
  if (signal?.aborted) throw abortError(signal);
  if (typeof surface?.submit !== 'function') throw new Error('routine run: the session service is not running');
  const agentId = scheduleOwnerAgentId({ ownerAgentId });
  const homeId = agentHomeSessionId(agentId);
  const home = await loadSession(homeId);
  if (!home || home.closed === true) {
    throw new Error(`the bot "${agentId}" has no chat yet: open it once in the app`);
  }
  const queued = waiting.get(homeId) || 0;
  if (queued >= limit) throw new Error(`${limit} routine runs already wait in this bot's chat`);
  waiting.set(homeId, queued + 1);
  const trigger = normalizeRoutineTrigger({ kind, name, event });
  const header = routineTriggerHeader({ kind, name, project: cwd ? String(cwd) : '' });
  const content = automationPromptContent(`${header}\n\n${body}`, attachments);
  return new Promise((resolve, reject) => {
    let started = false;
    let aborted = false;
    let done = false;
    let unmark = () => {};
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (waiting.get(homeId) || 1) - 1;
      if (left > 0) waiting.set(homeId, left);
      else waiting.delete(homeId);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };
    const abortTurn = () =>
      Promise.resolve()
        .then(() => surface.abort?.(homeId))
        .catch((error) => log(`aborting ${kind} "${name}" in ${homeId} failed: ${error?.message || error}`));
    function onAbort() {
      aborted = true;
      if (started) void abortTurn();
      finish(reject, abortError(signal));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const options = {
      id: `routine_${randomUUID()}`,
      mode: 'routine',
      // Runs after the thread's current turn, never steered into it.
      priority: 'later',
      isMeta: true,
      skipSlashCommands: true,
      restorable: false,
      // Esc ends this fire; it is never put back in the queue.
      abortDiscardOnAbort: true,
      skillSelection: String(skillSelection ?? body),
      transcriptMeta: { routineTrigger: trigger },
      onCommitted: () => {
        if (started) return;
        started = true;
        // Nobody watches this turn: it never asks (run-policy.mjs).
        unmark = markUnattendedRun(homeId, { kind, agentId, name });
        if (aborted) void abortTurn();
      },
      onSettled: (detail) => {
        // Read before unmarking: a step only a person can do ended the turn.
        const human = unattendedRunOf(homeId)?.humanNeeded;
        unmark();
        release();
        if (human) finish(reject, new Error(routineHumanNeededText(human.outcome, human.site)));
        else if (detail?.status === 'done') {
          finish(resolve, { sessionId: homeId, result: String(detail?.result?.content || '') });
        } else finish(reject, settledError(detail));
      },
    };
    Promise.resolve()
      .then(() => surface.submit(homeId, content, options))
      .then((accepted) => {
        if (accepted === true) return;
        release();
        finish(reject, new Error(`the bot's chat did not accept the ${kind} "${name}"`));
      })
      .catch((error) => {
        release();
        finish(reject, error);
      });
  });
}

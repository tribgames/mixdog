// ask_user: put 1-4 multiple-choice questions to the user through the session's
// tool-approval hook (kind: 'question') and report the answers to the model.
import { randomUUID } from 'node:crypto';
import {
  validateAskUserHandoff,
  validateAskUserQuestions,
  ASK_USER_MAX_TEXT,
} from '../../runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';
import { runAbortable } from '../../runtime/shared/abort-race.mjs';
import { SECRET_REQUEST_TIMEOUT_MS } from '../../runtime/agent/orchestrator/session/human-gate/requests.mjs';
import {
  agentIdForSession,
  recordHumanDecision,
  unattendedApprovalPort,
} from '../../runtime/agent/orchestrator/session/human-gate/gate.mjs';
import { browserSecretInput } from '../../runtime/browser-bridge/client.mjs';
import { computerSecretInput } from '../../runtime/computer-bridge/client.mjs';

/**
 * A secret or takeover handoff. Secret: the card collects the value on the
 * desktop, which holds it for `requestId` and fills it into the target field
 * (isolated-world fill for the browser, one-shot typed input for computer
 * use); here only the verdict travels, and the result is exactly 'provided',
 * 'skipped' or 'timeout'. Takeover: the run waits until the user says done
 * (computer and browser actions stay blocked meanwhile, desktop
 * main/takeover-gate.ts); the result is 'done' or 'denied'.
 */
export async function runAskUserHandoff(handoff, { hook, sessionId, toolCallId, signal, inputs = {} }) {
  const secretInput = {
    browser: inputs.browser || browserSecretInput,
    computer: inputs.computer || computerSecretInput,
  };
  const gate = {
    agentId: agentIdForSession(sessionId),
    kind: handoff.kind,
    tool: `ask_user:${handoff.surface}`,
    target: handoff.target || handoff.field || '',
  };
  // A schedule or webhook run has nobody to take over: the step ends it now,
  // reported by what it needs (a sign-in, a step, a confirmation), never a waiting card.
  const outcome = HANDOFF_OUTCOMES[handoff.need] || HANDOFF_OUTCOMES.action;
  if (
    handoff.kind === 'takeover' &&
    (await unattendedApprovalPort()?.humanNeeded?.(sessionId, outcome, handoffSite(handoff)))
  ) {
    return UNATTENDED_TAKEOVER;
  }
  if (typeof hook !== 'function') {
    // Nobody can take over here: blocked, never "proceed".
    if (handoff.kind === 'takeover') return NO_TAKEOVER;
    await recordHumanDecision(gate, { response: 'skipped' });
    return 'skipped';
  }
  if (handoff.kind === 'secret') {
    const requestId = `secret_${randomUUID()}`;
    const result = await runAbortable(signal, () =>
      hook({
        name: 'ask_user',
        kind: 'secret',
        secret: { requestId, surface: handoff.surface, target: handoff.target, field: handoff.field },
        reason: '',
        timeoutMs: SECRET_REQUEST_TIMEOUT_MS,
        sessionId,
        toolCallId,
      })
    );
    let verdict = 'skipped';
    if (result?.timedOut === true) verdict = 'timeout';
    else if (result?.approved === true && result.response === 'provide-secret') {
      verdict = await secretInput[handoff.surface](sessionId, requestId, { signal });
    }
    await recordHumanDecision(gate, { response: verdict, device: result?.device });
    return verdict;
  }
  const result = await runAbortable(signal, () =>
    hook({
      name: 'ask_user',
      kind: 'takeover',
      takeover: {
        surface: handoff.surface,
        instructions: handoff.instructions,
        target: handoff.target,
        ...handoff.identity,
        // A login takeover: the desktop opens its sign-in window on this page.
        ...(handoff.login ? { purpose: 'login', url: handoff.login.url } : {}),
      },
      args: { surface: handoff.surface, instructions: handoff.instructions },
      reason: '',
      timeoutMs: null,
      sessionId,
      toolCallId,
    })
  );
  const answer = result?.approved === true ? 'done' : 'denied';
  await recordHumanDecision(gate, { response: answer, device: result?.device });
  return answer;
}

/** The unattended outcome of a takeover by what it needs (routine-result.mjs). */
const HANDOFF_OUTCOMES = Object.freeze({
  sign_in: 'login_required',
  action: 'human_action_required',
  confirmation: 'sensitive_confirmation_required',
});
const UNATTENDED_TAKEOVER =
  'Nobody is present in this routine run, so it ends here and the user is told what needs them. Stop; do not retry or work around this step.';
const NO_TAKEOVER =
  'Blocked: nobody can take over in this session, so this step was not done. Stop and tell the user what needs them; do not work around it.';

/** The site a takeover is about: the first host its target (or instructions)
 *  names, else the target as the model wrote it. */
export function handoffSite(handoff) {
  if (handoff.login) return new URL(handoff.login.url).hostname;
  for (const text of [handoff.target, handoff.instructions]) {
    const host = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i.exec(String(text || ''))?.[1];
    if (host) return host.toLowerCase();
  }
  return String(handoff.target || '').trim();
}

const NO_USER =
  'No user is available to answer in this session. Proceed with your best judgment and state the choices you made.';
const DISMISSED =
  'User closed the questions without answering. Proceed with your best judgment; ask again only if something new depends on it.';

/** Wire answers -> array aligned with questions; invalid entries become null. */
export function normalizeAskUserAnswers(answers, questions) {
  const list = Array.isArray(answers) ? answers.slice(0, 4) : [];
  return questions.map((q, i) => {
    const entry = list[i];
    if (!entry || typeof entry !== 'object') return null;
    const labels = new Set(q.options.map((o) => o.label));
    const rawSelected = entry.selected == null ? [] : entry.selected;
    if (!Array.isArray(rawSelected) || !rawSelected.every((l) => typeof l === 'string' && labels.has(l))) return null;
    if (entry.text != null && (typeof entry.text !== 'string' || entry.text.length > ASK_USER_MAX_TEXT)) return null;
    const selected = q.multi_select === true ? [...new Set(rawSelected)] : rawSelected.slice(0, 1);
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!selected.length && !text) return null;
    return text ? { selected, text } : { selected };
  });
}

// Strings are JSON-quoted so a quote inside one cannot end it early; typed
// text stays apart from the picked labels (`"picked" + "typed" (typed)`).
export function formatAskUserAnswers(questions, answers) {
  const quote = (text) => JSON.stringify(text);
  const parts = questions.map((q, i) => {
    const a = answers[i];
    if (!a) return `${quote(q.question)}=(no answer)`;
    const picked = a.selected.length ? quote(a.selected.join(', ')) : '';
    const typed = a.text ? `${quote(a.text)} (typed)` : '';
    return `${quote(q.question)}=${[picked, typed].filter(Boolean).join(' + ')}`;
  });
  return `User has answered your questions: ${parts.join('; ')}. You can now continue with these answers in mind.`;
}

/** A composer message sent instead of (or with) picking: kept when it is a
 *  non-empty string within the typed-answer limit, else dropped. */
export function normalizeAskUserReply(reply) {
  if (typeof reply !== 'string' || reply.length > ASK_USER_MAX_TEXT) return '';
  return reply.trim();
}

// `User replied in chat: "<reply>". ` leads, then the usual picks sentence
// when any question was answered, else just the closing sentence.
export function formatAskUserResult(questions, answers, reply) {
  if (!reply) return formatAskUserAnswers(questions, answers);
  const lead = `User replied in chat: ${JSON.stringify(reply)}. `;
  if (answers.some(Boolean)) return `${lead}${formatAskUserAnswers(questions, answers)}`;
  return `${lead}You can now continue with these answers in mind.`;
}

export function createAskUserToolHandlers({ rt }) {
  const { sessionIdFor, signalFor } = createCallerContextResolvers(rt);
  return {
    ask_user: async (args, { callerCtx }) => {
      const handoff = validateAskUserHandoff(args);
      if (handoff) {
        return runAskUserHandoff(handoff, {
          hook: callerCtx?.toolApprovalHook,
          sessionId: sessionIdFor(callerCtx),
          toolCallId: callerCtx?.toolCallId || null,
          signal: signalFor(callerCtx),
        });
      }
      const questions = validateAskUserQuestions(args);
      const hook = callerCtx?.toolApprovalHook;
      if (typeof hook !== 'function') return NO_USER;
      // No wait limit (timeoutMs: null): the question settles when the user
      // answers or dismisses it, or the turn is aborted.
      const result = await runAbortable(signalFor(callerCtx), () =>
        hook({
          name: 'ask_user',
          kind: 'question',
          args: { questions },
          reason: '',
          timeoutMs: null,
          sessionId: sessionIdFor(callerCtx),
          toolCallId: callerCtx?.toolCallId || null,
        })
      );
      if (result?.approved === true)
        return formatAskUserResult(
          questions,
          normalizeAskUserAnswers(result.answers, questions),
          normalizeAskUserReply(result.reply)
        );
      return DISMISSED;
    },
  };
}

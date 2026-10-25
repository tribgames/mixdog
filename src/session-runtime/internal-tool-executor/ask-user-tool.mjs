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
import {
  HANDOFF_OUTCOMES as AGENT_OUTCOMES,
  SECRET_REQUEST_TIMEOUT_MS,
} from '../../runtime/agent/orchestrator/session/human-gate/requests.mjs';
import {
  agentIdForSession,
  recordHumanDecision,
  unattendedApprovalPort,
} from '../../runtime/agent/orchestrator/session/human-gate/gate.mjs';
import { browserHandoffPage, browserSecretInput } from '../../runtime/browser-bridge/client.mjs';
import { computerSecretBind, computerSecretInput } from '../../runtime/computer-bridge/client.mjs';

/** The settle reason of a takeover that expired (desktop takeover-gate.ts
 *  TAKEOVER_EXPIRED_REASON). */
const TAKEOVER_EXPIRED_REASON = 'expired';

/**
 * The agent's result of a secret request, from the card's answer and the
 * desktop's fill: one of requests.mjs HANDOFF_OUTCOMES. `fill` runs only for a provided
 * value and answers 'entered' / 'no_field' / 'page_changed' / 'blocked' /
 * 'expired'.
 */
export async function secretOutcome(result, fill) {
  if (result?.timedOut === true || result?.reason === TAKEOVER_EXPIRED_REASON) return 'expired';
  if (result?.approved !== true || result.response !== 'provide-secret') return 'user_skipped';
  const filled = await fill();
  return AGENT_OUTCOMES.includes(filled) && filled !== 'user_skipped' ? filled : 'blocked';
}

/** A page address as the agent may see it: origin and path, no query or
 *  fragment (a sign-in redirect can carry a code or token there). */
function factUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : '';
  } catch {
    return '';
  }
}

/** The agent's result of a takeover: what the user did and where the page is
 *  now, never "signed in" (the agent checks the page). */
export function takeoverOutcome(result, pageUrl = '') {
  if (result?.timedOut === true || result?.reason === TAKEOVER_EXPIRED_REASON) return 'expired';
  if (result?.approved !== true) return 'user_skipped';
  const url = factUrl(pageUrl);
  const did = result.reason === 'saved_login' ? 'User chose a saved login; it was filled in' : 'User pressed Done';
  return url ? `${did}; page now at ${url}` : did;
}

/**
 * A secret or takeover handoff. Secret: at request time the desktop binds the
 * request to its page ({pageId, origin}) or, for computer use, it is bound to
 * {window_id, ref}; the card collects the value on the desktop, which holds it
 * for `requestId` and fills only that page, only while its origin is
 * unchanged. Here only the outcome travels (secretOutcome). Takeover: the run
 * waits until the user says done (that session's actions stay blocked
 * meanwhile, desktop main/takeover-gate.ts); the result is takeoverOutcome's.
 */
export async function runAskUserHandoff(handoff, { hook, sessionId, toolCallId, signal, inputs = {} }) {
  const secretInput = {
    browser: inputs.browser || browserSecretInput,
    computer: inputs.computer || computerSecretInput,
  };
  const page = inputs.page || browserHandoffPage;
  const bindComputer = inputs.computerBind || computerSecretBind;
  const identity = handoff.identity || {};
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
    // Nobody can take over or type here: blocked, never "proceed".
    if (handoff.kind === 'takeover') return NO_TAKEOVER;
    await recordHumanDecision(gate, { response: 'blocked' });
    return 'blocked';
  }
  if (handoff.kind === 'secret') {
    const requestId = `secret_${randomUUID()}`;
    // Bound now: the page (and its origin) the value may go to, and what its
    // field is. A browser page that cannot be bound, or has no such field,
    // never asks the user for a value it could not place.
    let bound = {};
    if (handoff.surface === 'browser') {
      const facts = await page(
        sessionId,
        'secret_bind',
        { request_id: requestId, ...(identity.tab ? { tab: identity.tab } : {}), field: handoff.field },
        { signal }
      );
      const outcome = !facts?.origin ? 'blocked' : facts.form ? '' : 'no_field';
      if (outcome) {
        await recordHumanDecision(gate, { response: outcome });
        return outcome;
      }
      bound = { origin: facts.origin, form: facts.form, ...(facts.length ? { length: facts.length } : {}) };
    } else {
      // Computer Use: bound to the exact window and field ref the agent named
      // (from snapshot/find). Without both there is no field to confirm, and
      // none is made up (never the focused field or the front window).
      const outcome =
        identity.windowId && identity.ref
          ? await bindComputer(sessionId, requestId, { windowId: identity.windowId, ref: identity.ref, signal })
          : 'no_field';
      if (outcome !== 'bound') {
        const refused = outcome === 'no_field' ? 'no_field' : 'blocked';
        await recordHumanDecision(gate, { response: refused });
        return refused;
      }
    }
    const result = await runAbortable(signal, () =>
      hook({
        name: 'ask_user',
        kind: 'secret',
        secret: { requestId, surface: handoff.surface, target: handoff.target, field: handoff.field, ...bound },
        reason: '',
        timeoutMs: SECRET_REQUEST_TIMEOUT_MS,
        sessionId,
        toolCallId,
      })
    );
    const computerTarget = {
      ...(identity.ref ? { ref: identity.ref } : {}),
      ...(identity.windowId ? { windowId: identity.windowId } : {}),
    };
    const outcome = await secretOutcome(result, () =>
      secretInput[handoff.surface](sessionId, requestId, {
        signal,
        ...(handoff.surface === 'computer' ? computerTarget : {}),
      })
    );
    await recordHumanDecision(gate, { response: outcome, device: result?.device });
    return outcome;
  }
  // A sign-in page's saved logins (masked) let the card fill one for the
  // user: the desktop offers them only for a page on that origin, bound now
  // under `fillId` so the fill reaches that page alone (host-agent.ts fillBoundLogin).
  const fillId = handoff.login ? `secret_${randomUUID()}` : '';
  const accounts = handoff.login
    ? (
        await page(
          sessionId,
          'login_accounts',
          { url: handoff.login.url, request_id: fillId, ...(identity.tab ? { tab: identity.tab } : {}) },
          { signal }
        )
      )?.accounts
    : null;
  const result = await runAbortable(signal, () =>
    hook({
      name: 'ask_user',
      kind: 'takeover',
      takeover: {
        surface: handoff.surface,
        instructions: handoff.instructions,
        target: handoff.target,
        ...identity,
        // A login takeover: the desktop opens its sign-in window on this page.
        ...(handoff.login ? { purpose: 'login', url: handoff.login.url } : {}),
        ...(Array.isArray(accounts) && accounts.length ? { accounts, fillId } : {}),
      },
      args: { surface: handoff.surface, instructions: handoff.instructions },
      reason: '',
      timeoutMs: null,
      sessionId,
      toolCallId,
    })
  );
  const pageUrl =
    result?.approved === true && handoff.surface === 'browser'
      ? (await page(sessionId, 'page_url', identity.tab ? { tab: identity.tab } : {}, { signal }))?.url
      : '';
  const answer = takeoverOutcome(result, pageUrl);
  await recordHumanDecision(gate, {
    response: answer.startsWith('User ') ? 'done' : answer,
    device: result?.device,
  });
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

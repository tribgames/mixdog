// ask_user: put 1-4 multiple-choice questions to the user through the session's
// tool-approval hook (kind: 'question') and report the answers to the model.
import {
  validateAskUserQuestions,
  ASK_USER_MAX_TEXT,
} from '../../runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';
import { runAbortable } from '../../runtime/shared/abort-race.mjs';

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

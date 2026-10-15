// ask_user: put 1-4 multiple-choice questions to the user through the session's
// tool-approval hook (kind: 'question') and report the answers to the model.
import { validateAskUserQuestions, ASK_USER_MAX_TEXT } from '../../runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';

export const ASK_USER_TIMEOUT_MS = 30 * 60 * 1000;
export const APPROVAL_TIMED_OUT_REASON = 'approval timed out';

const NO_USER = 'No user is available to answer in this session. Proceed with your best judgment and state the choices you made.';
const DISMISSED =
  'User closed the questions without answering. Proceed with your best judgment; ask again only if something new depends on it.';
const TIMED_OUT = `User did not answer in time. ${DISMISSED}`;

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

export function createAskUserToolHandlers({ rt }) {
  const { sessionIdFor } = createCallerContextResolvers(rt);
  return {
    ask_user: async (args, { callerCtx }) => {
      const questions = validateAskUserQuestions(args);
      const hook = callerCtx?.toolApprovalHook;
      if (typeof hook !== 'function') return NO_USER;
      const result = await hook({
        name: 'ask_user',
        kind: 'question',
        args: { questions },
        reason: '',
        timeoutMs: ASK_USER_TIMEOUT_MS,
        sessionId: sessionIdFor(callerCtx),
        toolCallId: callerCtx?.toolCallId || null,
      });
      if (result?.approved === true) return formatAskUserAnswers(questions, normalizeAskUserAnswers(result.answers, questions));
      return result?.reason === APPROVAL_TIMED_OUT_REASON ? TIMED_OUT : DISMISSED;
    },
  };
}

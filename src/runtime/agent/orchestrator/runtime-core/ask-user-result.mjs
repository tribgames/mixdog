// The text an ask_user call returns to the model for the user's decision:
// shared by the tool (ask-user-tool.mjs) and the hand-off copies of a
// question (tui/session/tool-approval.mjs), whose settled card shows the same
// record the asking session's transcript keeps.
import { ASK_USER_MAX_TEXT } from './ask-user-tool-defs.mjs';

const ASK_USER_DISMISSED =
  'User closed the questions without answering. Proceed with your best judgment; ask again only if something new depends on it.';

/** Wire answers -> array aligned with questions; invalid entries become null. */
function normalizeAskUserAnswers(answers, questions) {
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
function formatAskUserAnswers(questions, answers) {
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
function normalizeAskUserReply(reply) {
  if (typeof reply !== 'string' || reply.length > ASK_USER_MAX_TEXT) return '';
  return reply.trim();
}

// `User replied in chat: "<reply>". ` leads, then the usual picks sentence
// when any question was answered, else just the closing sentence.
function formatAskUserResult(questions, answers, reply) {
  if (!reply) return formatAskUserAnswers(questions, answers);
  const lead = `User replied in chat: ${JSON.stringify(reply)}. `;
  if (answers.some(Boolean)) return `${lead}${formatAskUserAnswers(questions, answers)}`;
  return `${lead}You can now continue with these answers in mind.`;
}

/** The ask_user result for `questions` (validated) and the hook's `result`
 *  (`{ approved, answers, reply }`): the answers, or the dismissal. */
export function askUserResultText(questions, result) {
  if (result?.approved !== true) return ASK_USER_DISMISSED;
  return formatAskUserResult(
    questions,
    normalizeAskUserAnswers(result.answers, questions),
    normalizeAskUserReply(result.reply)
  );
}

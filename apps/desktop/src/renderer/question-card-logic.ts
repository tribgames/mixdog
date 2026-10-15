/** Pure state rules of the ask_user question card. */
export type QuestionOption = { label: string; description: string };
export type Question = {
  question: string;
  header: string;
  options: QuestionOption[];
  multi_select?: boolean;
  recommended?: number;
};
/** One question's unsent answer: picked option indexes, or a typed text. */
export type QuestionDraft = { selected: number[]; text: string };
export type QuestionAnswer = { selected: string[]; text?: string } | null;
export type QuestionPrimary = 'skip' | 'next' | 'send' | 'close';

export const emptyDraft = (): QuestionDraft => ({ selected: [], text: '' });

export function isAnswered(draft: QuestionDraft | undefined): boolean {
  return Boolean(draft && (draft.selected.length > 0 || draft.text.trim()));
}

/** Picking an option clears the typed text; a single-select pick replaces. */
export function pickOption(draft: QuestionDraft, index: number, multi: boolean): QuestionDraft {
  if (!multi) return { selected: [index], text: '' };
  const selected = draft.selected.includes(index)
    ? draft.selected.filter((value) => value !== index)
    : [...draft.selected, index].sort((a, b) => a - b);
  return { selected, text: '' };
}

/** Typing clears the picked options. */
export function typeText(draft: QuestionDraft, text: string): QuestionDraft {
  return { selected: text.trim() ? [] : draft.selected, text };
}

/** Everything the card edits. Every mutation is a pure transition of the
 *  previous state, so rapid clicks or keys can never overwrite each other. */
export type QuestionState = { drafts: QuestionDraft[]; index: number; multi: boolean[] };
export type QuestionAction =
  | { type: 'pick'; option: number }
  | { type: 'text'; value: string }
  | { type: 'go'; index: number }
  | { type: 'step'; delta: number };

export function initQuestionState(questions: Question[]): QuestionState {
  return { drafts: questions.map(emptyDraft), index: 0, multi: questions.map((q) => q.multi_select === true) };
}

export function questionReducer(state: QuestionState, action: QuestionAction): QuestionState {
  const clamp = (index: number) => Math.min(state.drafts.length - 1, Math.max(0, index));
  if (action.type === 'go') return { ...state, index: clamp(action.index) };
  if (action.type === 'step') return { ...state, index: clamp(state.index + action.delta) };
  const edit = (next: QuestionDraft) => ({
    ...state,
    drafts: state.drafts.map((draft, i) => (i === state.index ? next : draft)),
  });
  const draft = state.drafts[state.index];
  if (action.type === 'text') return edit(typeText(draft, action.value));
  return edit(pickOption(draft, action.option, state.multi[state.index]));
}

/** The one adaptive button: nothing answered skips (and closes when it is the
 *  last question with nothing answered anywhere), an answer moves on or sends. */
export function primaryAction(drafts: QuestionDraft[], index: number): QuestionPrimary {
  const last = index >= drafts.length - 1;
  if (isAnswered(drafts[index])) return last ? 'send' : 'next';
  if (!last) return 'skip';
  return drafts.some(isAnswered) ? 'send' : 'close';
}

export function buildAnswers(questions: Question[], drafts: QuestionDraft[]): QuestionAnswer[] {
  return questions.map((question, index) => {
    const draft = drafts[index];
    if (!isAnswered(draft)) return null;
    const text = draft.text.trim();
    if (text) return { selected: [], text };
    return { selected: draft.selected.map((value) => question.options[value]?.label ?? '').filter(Boolean) };
  });
}

/** The questions of a `kind: 'question'` approval, or null when malformed. */
export function approvalQuestions(args: unknown): Question[] | null {
  const raw = (args as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.slice(0, 4).map((entry) => {
    const item = (entry ?? {}) as Partial<Question>;
    return {
      question: String(item.question ?? ''),
      header: String(item.header ?? ''),
      options: (Array.isArray(item.options) ? item.options : []).map((option) => ({
        label: String(option?.label ?? ''),
        description: String(option?.description ?? ''),
      })),
      multi_select: item.multi_select === true,
      ...(typeof item.recommended === 'number' ? { recommended: item.recommended } : {}),
    };
  });
}
